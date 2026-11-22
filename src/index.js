#!/usr/bin/env node
/**
 * 入口：把 App 里发来的需求变成一回合 dsh headless。
 *
 * 消息流：
 *   App（Flutter）→ HTTP → 这里 → spawn dsh → 解析 NDJSON
 *   → 分条写进消息库 → 检测 [[WAITING]] → 保存 sessionId 等用户下次发言
 *
 * QQ / NapCat / OneBot 那条链路已经整个删掉了：App 自己就是前端，
 * 不再需要中间人。
 */
import { loadConfig, reloadConfigInto, resolveModelEnv } from './config.js'
import { runTurn } from './runner.js'
import { createFlowBridge } from './flow-bridge.js'
import { getCheckpoint, CHECKPOINTS } from './flow/flow.js'
import { readReceipt } from './flow/orchestrator.js'
import { sleep } from './ui/format.js'
import { Runtime } from './runtime.js'
import { InstanceRegistry } from './instances.js'
import { createBridgeServer } from './ui/server.js'
import { join as pathJoin } from 'node:path'
import { SessionStore, GroupStateMachine, STATES } from './state.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { UserStore, roleLabelOf } from './account/store.js'
import { MessageStore } from './store/messages.js'
import { ArtifactStore } from './store/artifacts.js'
import { MemberStore } from './store/members.js'
import { createTransport } from './transport/transport.js'
import { createApiServer } from './api/server.js'
import { createThreadService } from './api/threads.js'
import { printQr } from './ui/qr.js'
import { networkInterfaces } from 'node:os'

/** 这台机器上手机大概能连到的 IPv4；0.0.0.0 监听时用来打印二维码。 */
function lanUrls(port) {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`)
    }
  }
  return out
}

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

const store = new SessionStore(config.repoRoot, config.stateDir)
const machine = new GroupStateMachine(config, store)

// 运行时状态中心：日志、回合、资源都从这里出去（面板 /api/status 的数据源）
const runtime = new Runtime({
  logDir: pathJoin(config.repoRoot, '.logs'),
  verbose: config.verbose,
})
const log = (...a) => runtime.info(...a)
const detail = (...a) => config.verbose && runtime.log('debug', ...a)

// ── App 通道的三套存储 ──
// 全部落在 .state/ 下，和状态机文件同目录，一起被 .gitignore 挡住。
// 分开建是为了各自能独立演进：消息量会一直涨，用户表基本不动，
// 混在一个文件里迟早因为写消息把用户表写坏。
const users = new UserStore(store.dir)
// 预设管理员必须在机器人之前建：ensureBootstrap 只在用户表为空时生效，
// 而 ensureBot 会往表里塞一个账号——顺序反了就永远建不出 admin/123456。
const boot = users.ensureBootstrap()
// 机器人也是个账号：先把它放进用户表，再让消息库把 role=bot 的消息挂到它名下
const botUser = users.ensureBot({ nickname: config.bot.name }).user
const messages = new MessageStore(pathJoin(store.dir, 'messages'), { bot: botUser })
const artifacts = new ArtifactStore(pathJoin(store.dir, 'artifacts'))
// 成员表：谁能看见哪个群。和用户表分开——用户表是全系统的账号，
// 成员表是「这个人进过这个群」，两件事的写频率也差得远。
const members = new MemberStore(pathJoin(store.dir, 'members'))

// 投递门面：编排层只说「说给谁听」，存储细节全在这里，见 transport/transport.js
const transport = createTransport({ messages, artifacts, log })

// v2 编排接入层。createFlowBridge 只捕获依赖，不立刻执行任何动作；
// sendPlain 是函数声明会提升，所以这里引用它不会碰到 TDZ。
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

log('编排：状态机驱动')
if (config.model?.provider) {
  log(`模型：${config.model.provider}/${config.model.model ?? '默认'}`)
}
log(`项目目录：${config.projectDir ?? '（未配置，接需求前先在面板添加仓库）'}`)

// 老配置里还写着 QQ 时代的段落。这些键现在完全不读，静默忽略比报错友好，
// 但如果一个字都不提，用户会以为「superAdmin 配了却不生效」是 bug。
if (config.obsoleteKeys?.length) {
  runtime.warn(`配置里这些键已经失效（QQ 通道已删除）：${config.obsoleteKeys.join('、')}`)
  runtime.warn('可以只删掉它们，或者照 bot.config.example.json 重新生成一份')
}

/**
 * 动作级权限。
 *
 * 身份有两个来源，都要看：
 *   - .state/users.json 里的账号角色（系统管理员 / 普通成员）
 *   - .state/members/members-<群>.json 里的群内角色（群主 / 群管理员 / 普通成员）
 *
 * 第二个来源是 App 化之后加的：群是私有的，建群的人就是群主，
 * 他该能在自己群里提需求和拍板，而不是只有系统管理员能。
 * 以前这里还有一路「问 NapCat 这个 QQ 号在群里是什么角色」，那个已经没了。
 *
 * @param {string} action startRequirement | confirm | command | release | read | comment
 * @param {string} groupId 会话标识（同时用来查群内角色）
 * @param {string} userId  用户表里的 id
 */
async function can(action, groupId, userId) {
  const uid = String(userId ?? '')
  if (!uid) return { ok: false, role: null, need: [] }
  const user = users.findById(uid)
  // 已停用的账号当作不存在：token 可能还没过期，但人已经被撤了
  if (!user || user.disabled) return { ok: false, role: null, roleLabel: null, need: [] }
  // 群内角色从成员表查：groupId 为空时（引擎回调没带群）就没有这一路
  let memberRole = null
  try {
    memberRole = groupId ? members.roleOf(groupId, uid) : null
  } catch {
    // 成员文件读坏了不该让整个权限判定炸掉：退回只看账号角色
    memberRole = null
  }
  const r = users.can(action, user, memberRole)
  // roleLabel 也一并带出去：拒绝时用户看到的是「普通成员」而不是裸的 member
  return { ok: r.ok, role: user.role, roleLabel: roleLabelOf(user.role), need: r.need }
}

// ────────────────────────────── 发消息 ──────────────────────────────

/**
 * 发消息。
 *
 * replyTo 以前是 QQ 的引用回复消息 id，现在没有引用回复这回事了，
 * 但参数保留：编排层有 26 处调用都带着它，删掉纯属改签名玩，
 * 行为上一点差别都没有。
 *
 * @param {string} groupId 会话标识（App 的 threadId）
 * @param {string} text 纯文本
 */
async function sendText(groupId, text) {
  try {
    await transport.sendText(groupId, text)
  } catch (err) {
    log(`发送失败（${groupId}）：${err.message}`)
  }
}

async function sendPlain(groupId, text, { replyTo } = {}) {
  await sendText(groupId, text, { replyTo })
}


// ────────────────────────────── 启动 ──────────────────────────────

// 启动时清理脏状态：bridge 上一次退出时若有回合在跑，.state 里会留下
// status=running 但 sessionId=null 的孤儿（正常 running 必有 sessionId）。
// 置回 waiting，防止用户的新消息被「上一个回合还在跑」卡住。
function cleanupOrphanStates() {
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
// 延后一点：等 App API 起来、状态机就绪后再补发提示
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
      // 没配项目仓库时 projectDir 是 null（取自 config.repos[0]）。
      // 这时群只是「容器」，还没绑需求，不能因为没项目就把它们全过滤掉——
      // 否则 App 里刚建的群会立刻从列表里消失。
      if (!g.projectDir) return true
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
        groupName: null,
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
      groupName: null,
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
      // App API 的端口，0=没启用。面板上要能看出「App 那条路通不通」，
      // 否则用户配了 api 却连不上时无从下手。
      appApiPort,
      startedAt: runtime.startedAt,
      nodeVersion: process.version,
      cwd: process.cwd(),
    },
    config: {
      profile: config.profile,
      botName: botUser.nickname,
      // 项目不再绑死：改哪个仓库由每条需求的内容决定（见 pickRepoFor）
      projectDir: null,
      // 团队化改造后新增的三处路径与并发上限，面板要能看到实际用的是哪
      repoDir: config.repoDir,
      worktreeRoot: config.worktreeRoot,
      dataRoot: config.dataRoot,
      limits: config.limits,
      model: config.modelLabel ?? null,
      heartbeatMinutes: config.heartbeat?.idleMinutes ?? 5,
      turnTimeoutMin: Math.round(config.turnTimeoutMs / 60000),
      stageTimeouts: config.stageTimeouts ?? null,
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
/** App 公网 API 的实际端口，0 表示没起。面板快照会带上它，方便排查连不通 */
let appApiPort = 0

// App 的群通道：把 API 的请求接到现有编排层上。
// 单机形态下 dispatch 直接调 flowBridge；拆分成 IM + 引擎之后只换这一个
// 函数（见 src/im.js），建群 / 投递 / 列表的逻辑一行都不用改。
const threads = createThreadService({
  store: machine.store,
  messages,
  members,
  botUser,
  buildSnapshot,
  can,
  log,
  botName: botUser.nickname,
  dispatch: async ({ threadId, text, user, replyTo, answers }) => {
    const st = machine.peek(threadId)
    if (!st) return { ok: false, error: '这个群当前不接受需求' }

    const initiator = { userId: user.userId, nickname: user.nickname, at: Date.now() }
    machine.store.save(threadId, { ...st, initiator, lastActiveAt: initiator.at })

    // 不等回合跑完：一条需求可能几十分钟，HTTP 请求等不起。
    // 失败要让用户看见，否则他只会觉得「agent 不理我」。
    void flowBridge
      .handleMessage({
        groupId: threadId,
        text,
        replyTo,
        st,
        initiator,
        answers: Array.isArray(answers) ? answers : null,
        can: (action, uid) => can(action, threadId, uid),
      })
      .catch((err) => {
        log(`[api] 群 ${threadId} 处理失败：${err.message}`)
        try {
          messages.append(threadId, {
            role: 'bot',
            kind: 'text',
            payload: { text: `处理失败：${err.message}` },
          })
        } catch {
          /* ignore */
        }
      })
    return { ok: true }
  },
})

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

/**
 * App 的公网 API。
 *
 * 和面板是两个独立 server，理由见 config.js 里 api 段的注释：
 * 面板能停群改配置且 token 为空时放行，绝不能公网可达。
 *
 * 默认不启用（config.api.enabled 必须显式 true）。这个进程能 spawn 任意回合、
 * 在本地仓库里跑 git，没配好隧道和域名就开到 0.0.0.0 等于把机器交出去。
 */
function startAppApi() {
  if (config.api?.enabled !== true) {
    runtime.info('App API 未启用（bot.config.json 里设 api.enabled=true 才开）')
    return
  }

  const server = createApiServer({
    users,
    messages,
    artifacts,
    members,
    threadInfo: threads.threadInfo,
    listThreads: threads.listThreads,
    deliver: threads.deliver,
    createGroup: threads.createGroup,
    joinGroup: threads.joinGroup,
    renameGroup: threads.renameGroup,
    membersOf: threads.membersOf,
    setMemberRole: threads.setMemberRole,
    markRead: threads.markRead,
    // App 用这个名字拼「@AI员工」，改名只改配置就行
    botName: botUser.nickname,
    log,
    allowedOrigin: config.api.allowedOrigin ?? '',
  })

  server.once('error', (err) => {
    // 起不来不该带走整个进程：别的端口可能还能用
    runtime.error(`App API 启动失败（端口 ${config.api.port}）：${err.message}`)
  })

  server.listen(config.api.port, config.api.host, () => {
    const { port, address } = server.address()
    appApiPort = port
    // 监听在 0.0.0.0 时 address 本身不能填进手机，换成局域网 IP。
    // 走隧道的人把 api.publicUrl 填成隧道域名，这里就以那个为准。
    const urls = config.api.publicUrl
      ? [config.api.publicUrl]
      : address === '0.0.0.0' || address === '::'
        ? lanUrls(port)
        : [`http://${address}:${port}`]
    runtime.info(`App API：${(urls[0] ?? `http://${address}:${port}`)}/healthz`)
    for (const url of urls.slice(0, 3)) printQr(url)

    // 预设管理员：新装的系统不该要求人先会注册才能进去。
    // 启动时已经建过了（见 store 初始化那段，必须在 ensureBot 之前），这里只负责播报。
    if (boot.created) {
      runtime.info(`已创建预设管理员：${boot.user.username} / 123456`)
      runtime.warn('这个密码是公开的，登录后请立刻在「账号管理」里改掉')
      const openToAll = address === '0.0.0.0' || address === '::'
      if (openToAll) {
        runtime.warn(`现在这个端口对全网开放（${address}），拿到地址的人都能用预设账号登进来`)
        runtime.warn('要么先改密码，要么把 api.host 收成 127.0.0.1 用隧道转发')
      }
    } else if (users.needsFirstAdmin()) {
      // 用户表非空但没有管理员（被降级/停用光了），这时不能自动补一个 admin，
      // 否则等于留了个后门。让用户知道该怎么救。
      runtime.warn('用户表里有账号但没有可用的管理员——预设账号只在空表时创建')
      runtime.warn('删掉 .state/users.json 重启可以回到初始状态（数据会丢）')
    }
  })
}

startApi()
startAppApi()

await ensureCheckouts()

const shutdown = () => {
  log('正在退出…')
  // 有回合在跑时留一条消息，用户下次打开 App 能知道发生了什么，
  // 而不是看着一个永远「进行中」的卡片干等。
  try {
    for (const groupId of machine.active.keys()) {
      if (machine.isRunning(groupId)) {
        // 尽力而为：写盘本身也可能失败
        transport
          .sendText(groupId, '服务正在重启，这一回合被打断了。回来发一条消息就能接上。')
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
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
