#!/usr/bin/env node
/**
 * 入口：连接 OneBot，把群里 @产品同学 的消息变成一回合 dsh headless。
 *
 * 消息流：
 *   QQ 群 → NapCat → WebSocket → 这里 → spawn dsh → 解析 NDJSON
 *   → 分条推送回群 → 检测 [[WAITING]] → 保存 sessionId 等下一次 @
 */
import { loadConfig, reloadConfigInto, resolveModelEnv } from './config.js'
import { OneBot } from './transport/onebot.js'
import { runTurn } from './runner.js'
import { createFlowBridge } from './flow-bridge.js'
import { getCheckpoint, CHECKPOINTS } from './flow/flow.js'
import { readReceipt } from './flow/orchestrator.js'
import { RateLimiter, sleep } from './ui/format.js'
import { Runtime } from './runtime.js'
import { renderMessage } from './ui/messages.js'
import { InstanceRegistry } from './instances.js'
import { createBridgeServer } from './ui/server.js'
import { join as pathJoin } from 'node:path'
import { SessionStore, GroupStateMachine, STATES } from './state.js'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const configPath = process.argv.find((a) => a.startsWith('--config='))?.slice(9)
const isDryRun = process.argv.includes('--dry-run')

/** 决策格式不合规时，自动让 agent 重写的最大次数 */
const MAX_DECISION_RETRY = 3

let config
try {
  config = loadConfig(configPath)
} catch (err) {
  console.error(`[启动失败] ${err.message}`)
  process.exit(1)
}

// 模型凭证：dsh 的 llm-pi-ai 按 provider 的 apiKeyEnv 读环境变量，
// 所以启动时把所有可能用到的 key 一并备好，缺哪个由 provider 自己报错。
const modelEnv = resolveModelEnv()
if (!Object.keys(modelEnv).length) {
  console.error(
    '[启动失败] 找不到任何模型凭证。\n' +
      '请在 ~/.dsh/.credentials.yaml 的 refs 段写 DEEPSEEK_API_KEY 或 OPENCODE_GO_API_KEY，\n' +
      '或直接 export 对应环境变量。',
  )
  process.exit(1)
}

const store = new SessionStore(config.repoRoot)
const machine = new GroupStateMachine(config, store)
const limiter = new RateLimiter(config.limits.maxMessagesPerMinute)
const bot = new OneBot(config.onebot)

// 运行时状态中心：日志、回合、资源都从这里出去（面板 /api/status 的数据源）
const runtime = new Runtime({
  logDir: pathJoin(config.repoRoot, '.logs'),
  verbose: config.verbose,
})
const log = (...a) => runtime.info(...a)
const detail = (...a) => config.verbose && runtime.log('debug', ...a)

// v2 编排接入层。createFlowBridge 只捕获依赖，不立刻执行任何动作；
// sendPlain 是函数声明会提升，所以这里引用它不会碰到 TDZ。
const flowBridge = createFlowBridge({
  config,
  store,
  machine,
  log,
  sendPlain,
  runTurn,
  bot,
  modelEnv,
  repoRoot: config.repoRoot,
})

log(`配置就绪：skill=${config.skillDir}`)
log('编排：状态机驱动')
log(`项目目录：${config.projectDir}`)
log(`群策略：${config.groupPolicy.mode}${config.groupPolicy.mode === 'auto' ? '（拉进哪个群就服务哪个群）' : ''}`)

/** 群成员角色缓存：`groupId:userId` → {role, at}。群管判定每条消息都要，缓存 5 分钟 */
const memberRoles = new Map()
const ROLE_TTL_MS = 5 * 60 * 1000

async function memberRole(groupId, userId) {
  if (!userId) return null
  const key = `${groupId}:${userId}`
  const hit = memberRoles.get(key)
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.role
  const role = await bot.getMemberRole(groupId, userId)
  if (role) memberRoles.set(key, { role, at: Date.now() })
  return role
}

/**
 * 动作级权限。不同动作对角色要求不同：
 *
 *   | 动作              | 群主 | 群管理员 | 系统管理员 | 普通成员 |
 *   | ----------------- | ---- | -------- | ---------- | -------- |
 *   | 发起需求          |  ✅  |    ❌    |     ✅     |    ❌    |
 *   | 阶段确认/斜杠指令 |  ✅  |    ✅    |     ✅     |    ❌    |
 *   | 交付（release）   |  ❌  |    ❌    |     ✅     |    ❌    |
 *
 * 注意区分两类「管理员」：
 *   - 群管理员（admin）：QQ 群里的管理员，只能管本群
 *   - 系统管理员（adminUsers）：这套系统的白名单，相当于上帝，任何群任何动作
 */
const ACTION_ROLES = {
  startRequirement: ['owner'],
  confirm: ['owner', 'admin'],
  command: ['owner', 'admin'],
  release: [],
}

/**
 * 判断某人能否在本群执行某个动作。
 * 系统管理员必须在群角色判定之前短路——否则一个不是群管理的系统管理员会被拒绝。
 */
async function can(action, groupId, userId) {
  const uid = String(userId ?? '')
  if (!uid) return { ok: false, role: null, need: ACTION_ROLES[action] ?? [] }
  if (config.superAdmin.includes(uid)) return { ok: true, role: 'superadmin' }
  if (config.adminUsers.includes(uid)) return { ok: true, role: 'systemAdmin' }
  const role = await memberRole(groupId, uid)
  const need = ACTION_ROLES[action] ?? []
  if (role && need.includes(role)) return { ok: true, role }
  return { ok: false, role, need }
}

/** 运行期发现的群：群号 → {name, memberCount}，用于日志和「本群」查询 */
const knownGroups = new Map()

// ────────────────────────────── 发消息 ──────────────────────────────

/**
 * 构造一条「引用回复」消息段。
 * @param {number|string} messageId 被引用的消息 id
 * @returns {object|null}
 */
/**
 * 发消息。replyTo 有值时以「引用回复」形式发出，跟真人回消息一样。
 * @param {string} groupId
 * @param {string} text 纯文本
 * @param {{replyTo?: number|string}} [opts]
 */
// 长任务阶段进展的最小间隔：够久才不会刷屏，够短才不会让人干等
// 距上次「群里收到消息」的时间——agent 内部活动不算，只由 sendText 成功发送后刷新。
// 模块级：sendText 与各群的心跳共用（bridge 当前只服务少数群，共享一个计时够用）。
let lastActivityAt = Date.now()

async function sendText(groupId, text) {
  const wait = limiter.delayFor()
  if (wait > 0) await sleep(wait)

  // 不引用用户消息、不 @ 人：引用会把一条普通播报变成一串嵌套卡片，
  // 群里刷起来更乱，而且 reply 段在某些客户端上会折叠正文。
  try {
    await bot.sendGroupMsg(groupId, text)
    lastActivityAt = Date.now() // 群里收到消息了，心跳重新计时
  } catch (err) {
    log(`发送失败（${groupId}）：${err.message}`)
  }
}

async function sendPlain(groupId, text, { replyTo } = {}) {
  await sendText(groupId, text, { replyTo })
}

// ────────────────────────────── 一回合 ──────────────────────────────

/** 从 OneBot 消息段里取纯文本 */
function extractText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message
    .filter((seg) => seg.type === 'text')
    .map((seg) => seg.data?.text ?? '')
    .join('')
}

/** 是否 @ 了本 bot */
function isAtMe(message, selfId) {
  if (!Array.isArray(message)) return false
  return message.some((seg) => seg.type === 'at' && String(seg.data?.qq) === String(selfId))
}

/** 去掉 @段，只留正文 */
function stripAt(message) {
  if (!Array.isArray(message)) return String(message ?? '')
  return message
    .filter((seg) => seg.type !== 'at')
    .map((seg) => (seg.type === 'text' ? seg.data?.text ?? '' : ''))
    .join('')
    .trim()
}

const STOP_WORDS = new Set(['停', '停止', '中断', '停一下', '取消'])
const HELP_WORDS = new Set(['帮助', 'help', '?', '？', '怎么用'])

// bot 的 QQ 真实昵称（get_login_info 拿），和配置里的自称 bot.name 是两回事
let botNickname = null

bot.on('connected', async () => {
  // 拉 bot 自己的 QQ 资料：面板要显示真实昵称，而不是配置里的自称
  const login = await bot.getLoginInfo()
  if (login?.nickname) {
    botNickname = login.nickname
    detail(`bot 真实昵称：${botNickname}`)
  }
  log(`已连接 OneBot：${config.onebot.ws}（bot=${config.bot.name} / ${botNickname ?? '昵称未知'}）`)
  // 连上就拉一次群列表：群号由 bot 自己报，配置里不用填
  try {
    const list = await bot.call('get_group_list', {}, 8000)
    if (Array.isArray(list) && list.length) {
      for (const g of list) {
        knownGroups.set(String(g.group_id), { name: g.group_name, memberCount: g.member_count })
      }
      const excluded = config.excludeGroups ?? []
      const usable = list.filter((g) => !excluded.includes(String(g.group_id)))
      log(`bot 已在 ${list.length} 个群里，服务其中 ${usable.length} 个：`)
      for (const g of list) {
        const skip = excluded.includes(String(g.group_id))
        log(`  ${skip ? '· [已排除]' : '·'} ${g.group_name}（${g.group_id}）`)
      }
      if (excluded.length) log(`排除名单：${excluded.join(', ')}（写在 bot.config.json 的 excludeGroups）`)
    } else {
      log('bot 还不在任何群里，把它拉进群后 @ 它就行。')
    }
    // 上次退出时还排在队列里的消息，bridge 重启不会自动补跑——
    // 明确告诉用户是哪几条，让人自己决定要不要重发。
    // 用 list（本次拉到的群），排除名单之外的群不打扰。
    for (const g of Array.isArray(list) ? list : []) {
      if ((config.excludeGroups ?? []).includes(String(g.group_id))) continue
      const pending = machine.pendingQueued(g.group_id)
      if (!pending.length) continue
      log(`[${g.group_id}] 有 ${pending.length} 条重启前未执行的消息，已提示用户重发`)
      bot
        .sendGroupMsg(
          g.group_id,
          renderMessage(
            'queuedLost',
            { count: pending.length, list: pending.map((t) => `· ${t}`).join('\n') },
            config.messageTemplates,
          ),
        )
        .catch(() => {})
      machine.clearQueued(g.group_id)
    }
  } catch (err) {
    log(`拉取群列表失败（不影响使用，收到消息时会自动识别）：${err.message}`)
  }
})

bot.on('disconnected', () => {
  log('OneBot 断开，自动重连中…')
})

// 连接失败给明确诊断，并做节流，避免重连时空刷屏
let lastDiagAt = 0
let diagHints = 0
bot.on('connection-error', (info) => {
  // 探测阶段先不打印，等结论出来
  if (info.probing) return

  const now = Date.now()
  if (now - lastDiagAt < 10000) return
  lastDiagAt = now

  log(`连不上 OneBot（第 ${info.failures} 次）：${info.reason ?? '未知原因'}`)
  if (diagHints++ === 0) {
    log(
      'NapCat 侧要开「WebSocket 服务端」：设置 → 网络配置 → 新建 WS 服务端，' +
        '端口与 onebot.ws 一致；有 token 就填到 onebot.token。',
    )
  }
})

/** 群里第一次见到这个名字时补登记，让日志和「本群」能显示群名 */
async function ensureGroupInfo(groupId) {
  if (knownGroups.has(groupId)) return knownGroups.get(groupId)
  try {
    const info = await bot.call('get_group_info', { group_id: Number(groupId), no_cache: false }, 5000)
    if (info?.group_id) {
      const v = { name: info.group_name, memberCount: info.member_count }
      knownGroups.set(groupId, v)
      log(`发现新群：${info.group_name}（${groupId}）`)
      return v
    }
  } catch {
    /* 拿不到就用作匿名群，不影响功能 */
  }
  knownGroups.set(groupId, { name: `群${groupId}`, memberCount: 0 })
  return knownGroups.get(groupId)
}

bot.on('message', async (frame) => {
  if (frame.message_type !== 'group') return
  const groupId = String(frame.group_id)

  // 群策略判定：auto 模式下这里永远放行，不需要预先填群号
  const resolved = machine.resolveGroup(groupId)
  if (!resolved.ok) {
    detail(`忽略群 ${groupId}：${resolved.reason}`)
    return
  }
  const st = machine.peek(groupId)
  if (!st) return

  // 只响应 @ 本 bot
  if (!isAtMe(frame.message, frame.self_id ?? bot.selfId)) return

  await ensureGroupInfo(groupId)

  // ── 权限闸门：只服务群主/群管理员，其他人的 @ 一律静默忽略 ──
  // 静默是有意的：群成员发消息时 bot 不做任何回应，避免刷屏和误触发。
  const speaker = frame.sender ?? {}
  const speakerId = String(speaker.user_id ?? frame.user_id ?? '')
  const gatePerm = await can('confirm', groupId, speakerId)
  if (!gatePerm.ok) {
    detail(`忽略 ${speakerId}（角色=${gatePerm.role ?? '未知'}）在群 ${groupId} 的消息`)
    return
  }

  // 回复时引用用户这条消息，比 @ 自己更像真人
  const replyTo = frame.message_id
  let text = stripAt(frame.message)

  // 记录发起人（面板列表要显示「谁提的需求」）
  const sender = speaker
  const initiator = {
    userId: String(sender.user_id ?? frame.user_id ?? ''),
    nickname: sender.card || sender.nickname || String(sender.user_id ?? ''),
    at: Date.now(),
  }
  if (initiator.userId && st.initiator?.userId !== initiator.userId) {
    st.initiator = initiator
    store.save(groupId, { ...st, initiator })
  } else if (initiator.userId && !st.initiator) {
    st.initiator = initiator
    store.save(groupId, { ...st, initiator })
  }
  log(`[${groupId}] 收到：${text.slice(0, 80)}`)

  // ── v2 编排：状态机是唯一真相源，不走下面的意图路由 ──
  // 分流点放在这里而不是更早，是因为权限、群信息、initiator 都已经就位。
  // v2 自己处理 /stop 和 /release，其余消息按「新需求 / 回答 / 排队」三态处理。
  // 状态机是唯一真相源：v2 自己处理 /stop 和 /release，
  // 其余消息按「新需求 / 回答 / 排队」三态处理。
  return flowBridge.handleMessage({
    groupId,
    text,
    replyTo,
    st,
    initiator,
    can: (action, uid) => can(action, groupId, uid),
  })
})

// ────────────────────────────── 启动 ──────────────────────────────

if (config.groupPolicy.mode === 'deny') {
  console.error('[启动失败] groupPolicy.mode=deny，不会服务任何群。')
  process.exit(1)
}
if (config.groupPolicy.mode === 'allowlist' && !config.groups.length) {
  console.error('[启动失败] groupPolicy.mode=allowlist 但 groups 为空，请在 groups 里列出允许的群。')
  process.exit(1)
}

// 启动时清理脏状态：bridge 上一次退出时若有回合在跑，.state 里会留下
// status=running 但 sessionId=null 的孤儿（正常 running 必有 sessionId）。
// 置回 waiting 并告知群里，防止用户的新消息被「上一个回合还在跑」卡住。
function cleanupOrphanStates() {
  // 遍历 .state 下所有群状态文件——groupPolicy=auto 时 config.groups 可能为空，
  // 按 config 遍历会漏掉自动发现群的状态
  for (const groupId of store.allGroupIds()) {
    const st = store.get(groupId)
    if (!st || st.status !== 'running' || st.sessionId) continue
    store.save(groupId, { ...st, status: 'waiting' })
    log(`[${groupId}] 清理孤儿回合状态（上次 bridge 退出时的残留）`)
  }
}
cleanupOrphanStates()

/**
 * 重启后接上被打断的回合。
 *
 * 回合结果靠读回执文件拿（不依赖子进程还活着），所以「进程死了但活干完了」能识别：
 * 回执在 → 直接继续推进；回执不在 → 告诉用户重跑这一步。
 * 子进程已 detached，正在跑的那个回合不会因为重启而死。
 */
/** 进程还活着吗（MSYS/Unix 通用；pid 可能被复用，所以只在高置信场景用） */
function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function recoverInterruptedFlows() {
  for (const groupId of store.allGroupIds()) {
    const st = store.get(groupId)
    const flow = st?.flow
    if (!flow || flow.status !== 'running' || !flow.current) continue

    const cp = getCheckpoint(flow.current)
    if (!cp) continue

    const reqDir = flow.dataDir ?? join(flow.projectDir, 'docs/requirements', flow.reqId)
    const receipt = readReceipt(reqDir, cp.id)

    if (receipt.ok) {
      log(`[${groupId}] 「${cp.label}」的回合已完成（回执在），自动接着往下走`)
      flowBridge
        .handleMessage({ groupId, text: '继续', replyTo: null, st, initiator: null, can: null })
        .catch((err) => log(`[${groupId}] 恢复失败：${err.message}`))
    } else if (pidAlive(flow.activeTurn?.pid)) {
      // 子进程还活着：只是 bridge 换了进程，回合本身没断。
      // 这时提示「重跑」会让用户白等一次，也会让两份产物打架。
      log(`[${groupId}] 「${cp.label}」的子进程还活着（pid ${flow.activeTurn.pid}），等它写完回执`)
    } else if (st.recoverNotifiedFor !== cp.id) {
      log(`[${groupId}] 「${cp.label}」的回合被打断，等用户发继续`)
      store.save(groupId, { ...st, recoverNotifiedFor: cp.id })
      sendPlain(groupId, `上次「${cp.label}」的回合被打断了，回复「继续」重跑这一步。`, {}).catch(() => {})
    } else {
      log(`[${groupId}] 「${cp.label}」仍等待用户发继续（已提示过，不重复发）`)
    }
  }
}
// 延后一点：等 OneBot 连接建立后再往群里发言
setTimeout(recoverInterruptedFlows, 5000)

// ─────────────────── 管理面板的 HTTP API ───────────────────

/**
 * 组装本实例的状态快照。
 *
 * full=true  → /api/status，面板「详细信息」用：带阶段表和最近 50 条事件。
 * full=false → /api/summary，需求大盘列表用：只留列表画得出来的字段。
 *
 * 两者共用同一份计算，避免列表和详情各算一套、结果对不上。
 * 列表每 3 秒轮询一次，把 50 条日志和阶段表都带上纯属浪费带宽。
 */
/** 从 v2 流状态推导阶段列表，给面板详情用 */
function flowStages(flow) {
  const main = CHECKPOINTS.filter((c) => !['fix', 're-review', 'merge-fix'].includes(c.id))
  const idx = main.findIndex((c) => c.id === flow.current)
  return main.map((c, i) => {
    if (idx >= 0 && i < idx) return { name: c.label, status: '已完成' }
    if (idx === i) {
      if (flow.status === 'done') return { name: c.label, status: '已完成' }
      if (flow.status === 'blocked') return { name: c.label, status: '阻塞' }
      if (flow.status === 'waiting_user') return { name: c.label, status: '等待确认' }
      return { name: c.label, status: '进行中' }
    }
    return { name: c.label, status: '未开始' }
  })
}

async function buildSnapshot({ full = true } = {}) {
  const groups = machine
    .listAll()
    // 过滤掉项目目录已消失的残留（比如测试用临时目录留下的 state 文件）
    .filter((g) => {
      try {
        return existsSync(g.projectDir)
      } catch {
        return false
      }
    })
    .map((g) => {
    // v2：状态机自己就知道在哪一步，不需要解析编排记录。
    // 以前面板和回执都从同一份 markdown 里猜，格式一改两边一起错。
    if (g.flow) {
      const flow = g.flow
      const cp = flow.current ? getCheckpoint(flow.current) : null
      const statusText =
        { running: '进行中', waiting_user: '等你确认', blocked: '卡住', done: '已完成' }[flow.status] ?? '未开始'
      const item = {
        groupId: g.groupId,
        groupName: knownGroups.get(g.groupId)?.name ?? null,
        reqId: flow.reqId ?? null,
        name: flow.name ?? null,
        stage: cp?.label ?? (flow.status === 'done' ? '已交付' : null),
        stageStatus: statusText,
        status: flow.status === 'done' ? 'idle' : 'waiting',
        waitingLabel: flow.waiting?.decisions?.length
          ? `${flow.waiting.decisions.length} 项待决策`
          : flow.waiting?.reason ?? '',
        turn: g.turn ?? 0,
        initiator: g.initiator ?? null,
        lastActiveAt: g.lastActiveAt ?? null,
        activeTurn: runtime.turnInfo(g.groupId),
        // 团队化改造后每个需求有自己的工作区和文档目录，面板要能看到占用了什么
        workDir: flow.workDir ?? null,
        dataDir: flow.dataDir ?? null,
        featureBranch: flow.vars?.featureBranch ?? null,
      }
      if (full) {
        item.stageStartedAt = g.stageStartedAt || null
        item.stages = flowStages(flow)
      }
      return item
    }

    // 旧版（v1）绑过需求、但还没有 flow 的群。
    // v2 明确不接管这类群（见 flow-bridge 的提示），面板也只做只读展示——
    // 这里原本还去解析编排记录，但那套函数在 v2 重构里已经删掉，
    // 留着会让整个 /api/status 抛 groupStageTable is not defined。
    const item = {
      groupId: g.groupId,
      groupName: knownGroups.get(g.groupId)?.name ?? null,
      reqId: g.reqId ?? null,
      stage: null,
      stageStatus: '旧版需求',
      status: 'idle',
      waitingLabel: 'v2 不接管旧版绑定的需求',
      turn: g.turn ?? 0,
      initiator: g.initiator ?? null,
      lastActiveAt: g.lastActiveAt ?? null,
      activeTurn: runtime.turnInfo(g.groupId),
      legacy: true,
    }
    if (full) {
      item.stageStartedAt = g.stageStartedAt || null
      item.stages = []
    }
    return item
  })

  const snap = {
    instance: {
      pid: process.pid,
      port: apiPort,
      startedAt: runtime.startedAt,
      nodeVersion: process.version,
      cwd: process.cwd(),
      // QQ 真实昵称（get_login_info），和 config.botName（对外自称）区分开
      botNickname: botNickname ?? null,
    },
    config: {
      profile: config.profile,
      botQQ: config.bot.qq,
      botName: config.bot.name,
      // 群不再绑死项目：改哪个仓库由每条需求的内容决定（见 pickRepoFor）
      projectDir: null,
      // 团队化改造后新增的三处路径与并发上限，面板要能看到实际用的是哪
      repoDir: config.repoDir,
      worktreeRoot: config.worktreeRoot,
      dataRoot: config.dataRoot,
      limits: config.limits,
      groupPolicy: config.groupPolicy.mode,
      model: config.modelLabel ?? null,
      heartbeatMinutes: config.heartbeat?.idleMinutes ?? 5,
      turnTimeoutMin: Math.round(config.turnTimeoutMs / 60000),
      stageTimeouts: config.stageTimeouts ?? null,
    },
    onebot: {
      url: config.onebot.ws,
      connected: bot.connected === true,
      selfId: bot.selfId ?? null,
    },
    groups,
    resources: runtime.resources(),
    // 并发闸门快照：面板要回答「还能再并行几个需求」「谁在排队」
    pools: (await flowBridge.poolStats?.()) ?? null,
    at: Date.now(),
  }
  if (full) snap.recentEvents = runtime.recentLogs(50)
  return snap
}

/** 面板：终止某群当前任务 */
async function stopGroup(groupId) {
  const st = machine.peek(groupId)
  if (!st) return { ok: false, error: '这个群不在服务范围内' }
  const killed = machine.interrupt(groupId)
  return killed
    ? { ok: true, message: '已终止当前回合' }
    : { ok: false, error: '该群当前没有在跑的回合' }
}

/** 面板：重启某群任务（先掐断，再用「继续」骨架重新起一回合） */
async function restartGroup(groupId) {
  const st = machine.peek(groupId)
  if (!st) return { ok: false, error: '这个群不在服务范围内' }
  if (!st.flow) return { ok: false, error: '这个群还没有需求，直接 @ 它说要做什么就行' }

  machine.interrupt(groupId)
  await sleep(300)

  // 把状态从 running/blocked 拉回可执行，再走一遍正常的消息入口。
  // 不再自己拼 prompt——v2 的入口只认「新需求 / 回答 / 继续」三态。
  const flow = st.flow
  st.flow = { ...flow, status: 'running', waiting: null }
  store.save(groupId, st)

  await flowBridge.handleMessage({
    groupId,
    text: '继续',
    replyTo: null,
    st: machine.peek(groupId),
    initiator: null,
  })
  return { ok: true, message: '已重启' }
}

/**
 * 配了 git 链接但本地还没 clone 的仓库，启动时补上。
 * 失败不阻塞启动——用户可能只是暂时没网，或者那个仓库还没建。
 */
async function ensureCheckouts() {
  const { ensureCheckout } = await import('./infra/repo.js')
  for (const repo of config.repos ?? []) {
    if (!repo.url) continue
    if (existsSync(repo.path)) continue
    runtime.info(`[仓库] 首次克隆 ${repo.id}：${repo.url}`)
    const r = ensureCheckout({ checkoutDir: repo.path, url: repo.url })
    if (r.ok) runtime.info(`[仓库] ${repo.id} 就绪（${r.created ? '新克隆' : '已更新'}）`)
    else runtime.warn(`[仓库] ${repo.id} 克隆失败：${r.error}（用到时再试）`)
  }
}

// 实例注册 + HTTP 服务
const registry = new InstanceRegistry(config.repoRoot)
let apiPort = 0

function startApi() {
  if (config.panel?.enabled === false) return
  const server = createBridgeServer({
    runtime,
    config,
    snapshot: buildSnapshot,
    summary: () => buildSnapshot({ full: false }),
    stopGroup,
    restartGroup,
    // 面板保存设置后热更新，不用重启 bridge
    applySettings: (patch) => {
      if (patch?.messageTemplates !== undefined) {
        const next = Object.fromEntries(
          Object.entries(patch.messageTemplates).filter(([, v]) => typeof v === 'string' && v.trim()),
        )
        // 必须就地改内容，不能换对象：flow-bridge 启动时把 config.messageTemplates
        // 存成了局部引用，换掉对象它还在用旧的，改了文案看起来「没生效」。
        for (const k of Object.keys(config.messageTemplates)) delete config.messageTemplates[k]
        Object.assign(config.messageTemplates, next)
        const n = Object.keys(config.messageTemplates).length
        runtime.info(n ? `[面板] 群消息文案已更新（${n} 条自定义）` : '[面板] 群消息文案已全部回到默认')
      }
      if (patch?.stageTimeouts && typeof patch.stageTimeouts === 'object') {
        const pick = (v, dflt) => {
          const n = Number(v)
          return Number.isFinite(n) && n > 0 ? Math.min(180, Math.max(1, Math.round(n))) : dflt
        }
        const cur = config.stageTimeouts ?? {}
        config.stageTimeouts = {
          default: pick(patch.stageTimeouts.default, cur.default ?? 30),
          dev: pick(patch.stageTimeouts.dev, cur.dev ?? 60),
          test: pick(patch.stageTimeouts.test, cur.test ?? 60),
          acceptance: pick(patch.stageTimeouts.acceptance, cur.acceptance ?? 60),
        }
        config.turnTimeoutMs = config.stageTimeouts.default * 60000
        runtime.info(
          `[面板] 阶段超时已更新：默认 ${config.stageTimeouts.default} 分钟，` +
            `开发 ${config.stageTimeouts.dev}、测试 ${config.stageTimeouts.test}、验收 ${config.stageTimeouts.acceptance}`,
        )
      }
      if (Array.isArray(patch?.adminUsers)) {
        config.adminUsers = patch.adminUsers.map((x) => String(x))
        runtime.info(`[面板] 白名单已更新：${config.adminUsers.join(', ') || '（空）'}`)
      }
      // 项目（仓库）增删改：写回配置文件，再就地刷新内存里的 config，
      // 不用重启 bridge。新建/改名后模拟器服务那边要重新问一次能力。
      if (Array.isArray(patch?.repos) || patch?.platform !== undefined) {
        try {
          const onDisk = JSON.parse(readFileSync(config.configPath, 'utf8'))
          if (Array.isArray(patch.repos)) {
            onDisk.repos = patch.repos
            config.repos = patch.repos
          }
          if (patch.platform !== undefined) {
            onDisk.platform = patch.platform
            config.platform = patch.platform
          }
          writeFileSync(config.configPath, JSON.stringify(onDisk, null, 2) + '\n')
          reloadConfigInto(config)
          runtime.info(
            `[面板] 项目配置已更新：${config.repos.map((r) => `${r.id}(${r.platform})`).join('、')}`,
          )
        } catch (err) {
          return { ok: false, error: `保存项目配置失败：${err.message}` }
        }
      }
      return { ok: true }
    },
    token: config.panel?.token ?? '',
  })
  const tryListen = (port, attempt = 0) => {
    server.once('error', (err) => {
      // 端口被占就直接报错退出，不要自动换端口。
      // 换端口的结果是：旧进程没死、新进程在 7881 悄悄跑起来，
      // 两个实例都在连 QQ，都在回消息，而且面板只看得到其中一个。
      if (err.code === 'EADDRINUSE') {
        runtime.error(
          `端口 ${port} 已被占用——多半是上一个实例没退干净。` +
            `先 pkill -f 'src/index.js' 再启动，不要让它自己换端口。`,
        )
        process.exit(1)
      }
      runtime.error(`HTTP API 启动失败：${err.message}`)
      if (attempt < 20) tryListen(port + 1, attempt + 1)
    })
    server.listen(port, '127.0.0.1', () => {
      apiPort = server.address().port
      registry.register({
        pid: process.pid,
        port: apiPort,
        profile: config.profile,
        // 注册用主仓库路径：这是「实例在哪跑」的标识，和需求落哪个仓库无关
        projectDir: config.projectDir,
        logFile: pathJoin(config.repoRoot, '.logs'),
        gitCommit: process.env.GIT_COMMIT ?? null,
        version: '0.1.0',
      })
      runtime.info(`面板 API：http://127.0.0.1:${apiPort}/api/status`)
      const siblings = registry.findSiblings(config.projectDir, process.pid)
      if (siblings.length) {
        runtime.warn(
          `检测到 ${siblings.length} 个其他实例正在服务同一项目（PID ${siblings.map((x) => x.pid).join(', ')}）——会重复响应群消息`,
        )
      }
    })
  }
  tryListen(config.panel?.port ?? 7878)
}

startApi()

await ensureCheckouts()
bot.connect()

const shutdown = () => {
  log('正在退出…')
  // 有回合在跑时告知群里，避免「发了消息没下文」
  try {
    for (const groupId of machine.active.keys()) {
      if (machine.isRunning(groupId)) {
        // 尽力而为：连接可能已断
        bot
          .sendGroupMsg(groupId, renderMessage('restartNotice', {}, config.messageTemplates))
          .catch(() => {})
      }
    }
  } catch {
    /* ignore */
  }
  try {
    registry.unregister()
  } catch {
    /* ignore */
  }
  runtime.close()
  bot.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
