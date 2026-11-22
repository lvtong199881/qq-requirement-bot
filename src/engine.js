#!/usr/bin/env node
/**
 * 需求引擎独立入口：只跑 dsh 回合，不提供登录、不存群消息。
 *
 * 它是 IM 的客户端：长轮询 GET /api/engine/inbox 拿「谁在哪个群说了什么」，
 * 用 POST /api/engine/messages 把 agent 说的话发回去，用
 * POST /api/engine/groups/:id 报阶段。
 *
 * 为什么拆成这样而不是让 IM 去调引擎：项目仓库、worktree、模拟器、模型凭证
 * 都在跑引擎的这台机器上，IM 那台通常没有也不该有。让谁掌握资源，就让谁监听；
 * 而 IM 是用户直接访问的入口，天然该是服务端。
 *
 * 和 src/index.js 的关系：那个入口是「IM + 引擎塞在一个进程里」的老用法，
 * 还在用、也还留着（单机部署最简单）。两边共用同一份 flow-bridge 和状态机。
 */
import { loadConfig, resolveModelEnv } from './config.js'
import { runTurn } from './runner.js'
import { createFlowBridge } from './flow-bridge.js'
import { getCheckpoint } from './flow/flow.js'
import { SessionStore, GroupStateMachine } from './state.js'
import { createHttpTransport } from './transport/http.js'
import { isAppThread } from './api/threads.js'
import { sleep } from './ui/format.js'

const configPath = process.argv.find((a) => a.startsWith('--config='))?.slice(9)

const log = (...a) => console.log('[engine]', ...a)

let config
try {
  config = loadConfig(configPath)
} catch (err) {
  console.error(`[启动失败] ${err.message}`)
  process.exit(1)
}

const imUrl = String(config.im?.url ?? '').replace(/\/+$/, '')
const imToken = String(config.im?.token ?? '')
if (!imUrl || !imToken) {
  console.error(
    '[启动失败] 引擎要连一台 IM，但 bot.config.json 里没有 im.url / im.token。\n' +
      '先在 IM 那台机器启动 src/im.js，它会打印一次引擎密钥，抄到这里的 im.token。',
  )
  process.exit(1)
}

// 模型凭证：少了它跑不了任何回合，启动就报错比跑到一半失败好
const modelEnv = resolveModelEnv(config)
if (!Object.keys(modelEnv).length) {
  const wanted = config.model?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  console.error(
    '[启动失败] 找不到任何模型凭证。\n' +
      `请在 ~/.dsh/.credentials.yaml 的 refs 段写 ${wanted}，\n` +
      '或直接 export 对应环境变量（也认 DEEPSEEK_API_KEY / OPENCODE_GO_API_KEY）。',
  )
  process.exit(1)
}

// 引擎自己的工作目录：flow 状态、worktree、文档都在本机，和 IM 的 .state 分开。
// 唯一共享的是「群 id」这个字符串。
const stateDir = config.stateDir
const store = new SessionStore(config.repoRoot, stateDir)
const machine = new GroupStateMachine(config, store)

const transport = createHttpTransport({ url: imUrl, token: imToken, log })
const sendPlain = (threadId, text) => transport.sendText(threadId, text)

const flowBridge = createFlowBridge({
  config,
  store,
  machine,
  log,
  sendPlain,
  runTurn,
  transport,
  modelEnv,
  repoRoot: config.repoRoot,
})

/** 调 IM 的引擎接口，统一处理错误 */
async function api(path, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${imUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${imToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {
    /* 反代错误页 */
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `IM 返回 ${res.status}`)
  }
  return data
}

/**
 * 权限裁决回 IM 问：用户表只有那边有，引擎不该自己判。
 *
 * threadId 也要带上：群主/群管理员在自己群里能提需求，离开群就只剩账号角色。
 * IM 侧靠这个参数查成员表，不带的话「群主能提」在引擎这条路上就会失效。
 */
const can = async (action, userId, threadId = null) => {
  try {
    const q = new URLSearchParams({ action, userId: String(userId ?? '') })
    if (threadId) q.set('threadId', String(threadId))
    return await api(`/api/engine/can?${q.toString()}`)
  } catch (err) {
    log(`[engine] 权限查询失败：${err.message}`)
    // 查不到就当没权限：宁可拒绝，也不要因为连不上而放行
    return { ok: false, error: '权限查询失败' }
  }
}

/**
 * 处理一条事件。
 *
 * 不 await handleMessage：一条需求可能跑几十分钟，等它等于把后面的消息
 * 全堵住。同群的串行由 machine 的队列保证（见 flow-bridge 的排队分支）。
 */
function handleEvent(ev) {
  if (ev.type !== 'start' && ev.type !== 'message') return
  const threadId = String(ev.threadId ?? '')
  if (!isAppThread(threadId)) return
  const st = machine.peek(threadId)
  if (!st) {
    log(`[engine] 没有群 ${threadId} 的状态，跳过`)
    return
  }
  const initiator = {
    userId: ev.user?.userId ?? null,
    nickname: ev.user?.nickname ?? '',
    at: ev.at ?? Date.now(),
  }
  // 群名、模式由 IM 维护；引擎这边只补上「谁说的」
  machine.store.save(threadId, { ...st, initiator })

  void flowBridge
    .handleMessage({
      groupId: threadId,
      text: String(ev.text ?? ''),
      replyTo: null,
      st: machine.peek(threadId),
      initiator,
      // 卡片上勾了什么：有它就不用猜自然语言，逐条对得上的选择更可靠
      answers: Array.isArray(ev.answers) ? ev.answers : null,
      can: (action, uid) => can(action, uid, threadId),
    })
    .catch((err) => {
      log(`[engine] 群 ${threadId} 处理失败：${err.message}`)
      void transport.sendText(threadId, `处理失败：${err.message}`)
    })
}

/** 从状态里拼出「这个群现在到哪一步了」，字段名和 IM 侧的白名单对齐 */
function stageBody(groupId, st) {
  const flow = st?.flow
  if (!flow) return null
  const cp = flow.current ? getCheckpoint(flow.current) : null
  return {
    reqId: flow.reqId ?? null,
    reqName: flow.name ?? null,
    stage: cp?.label ?? (flow.status === 'done' ? '已交付' : null),
    stageStatus:
      { running: '进行中', waiting_user: '等你确认', blocked: '卡住', done: '已完成' }[flow.status] ?? '未开始',
    running: machine.isRunning(groupId),
    waitingLabel: flow.waiting?.decisions?.length
      ? `${flow.waiting.decisions.length} 项待决策`
      : (flow.waiting?.reason ?? ''),
    featureBranch: flow.vars?.featureBranch ?? null,
  }
}

/**
 * 把阶段报给 IM。
 *
 * 轮询而不是在每个状态变化处挂钩：阶段变化散落在 flow-bridge 十几处，
 * 挂钩要改一堆地方还容易漏。三秒一次的差量上报简单、也不会重复发。
 */
const lastReported = new Map()
async function reportStages() {
  for (const groupId of store.allGroupIds()) {
    if (!isAppThread(groupId)) continue
    let body
    try {
      body = stageBody(groupId, machine.peek(groupId))
    } catch {
      continue
    }
    if (!body) continue
    const sig = JSON.stringify(body)
    if (lastReported.get(groupId) === sig) continue
    try {
      await api(`/api/engine/groups/${encodeURIComponent(groupId)}`, { method: 'POST', body })
      lastReported.set(groupId, sig)
    } catch (err) {
      // 报不上去不影响跑活，下一轮还会再试
      log(`[engine] 阶段上报失败（${groupId}）：${err.message}`)
    }
  }
}

let alive = true
let cursor = 0
const waitMs = Math.min(30_000, Number(config.im?.pollWaitMs ?? 25_000) || 25_000)

async function loop() {
  log(`已连 ${imUrl}，开始长轮询（每次最多挂 ${Math.round(waitMs / 1000)} 秒）`)
  while (alive) {
    try {
      const r = await api(`/api/engine/inbox?after=${cursor}&wait=${waitMs}`, { timeoutMs: waitMs + 20_000 })
      cursor = Number(r.cursor ?? cursor) || cursor
      for (const ev of r.events ?? []) handleEvent(ev)
    } catch (err) {
      // IM 重启 / 网络抖动：退避后重连，游标不变，事件不会丢
      log(`连不上 IM：${err.message}（5 秒后重试）`)
      await sleep(5000)
    }
  }
}

const stageTimer = setInterval(() => {
  void reportStages()
}, 3000)
stageTimer.unref?.()

void loop()

const shutdown = () => {
  alive = false
  clearInterval(stageTimer)
  log('正在退出…')
  setTimeout(() => process.exit(0), 1500).unref()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
