/**
 * v2 接入层：QQ 群消息 → 状态机 → 回合。
 *
 * 和 v1 的根本区别：这里没有任何「猜」。当前在哪个阶段、在等什么、
 * 下一站去哪，全部由 flow.js 的状态机回答，不解析 agent 文本、不读产物表格、
 * 不猜用户意图。用户消息只有三种身份：
 *   · 群还没绑需求 → 这就是需求描述
 *   · 状态机在等用户 → 这就是回答（或拍板）
 *   · 正在跑 → 排队
 *
 * 副作用（发消息、起进程、写盘）都通过 deps 注入，方便单测。
 */
import { join, basename, dirname } from 'node:path'
import { optionLabel } from './flow/labels.js'
export { optionLabel }
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync, cpSync, copyFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { renderMessage } from './ui/messages.js'
import { formatDuration } from './ui/format.js'
import { parseCommand } from './commands.js'
import { initialState, resumeFromUser, reworkFromUser, currentCheckpoint, needsAgent, getCheckpoint } from './flow/flow.js'
import { runFlow } from './flow/flow-runner.js'
import { readReceipt, receiptFile } from './flow/orchestrator.js'
import { writeBoard } from './flow/board.js'
import { gitRun, detectMainBranch } from './infra/git.js'
import { runMergeScript } from './flow/merge-script.js'
import { acquireLock, SlotPool } from './infra/lock.js'
import { createEmulatorClient } from './infra/emulator-client.js'
import { platformOf, renderCommand } from './infra/platform.js'
import {
  ensureBareRepo,
  createWorktree,
  removeWorktree,
  ensureMergeWorktree,
  findOrphanWorktrees,
  pruneWorktrees,
  ensureDataDir,
  dataDirFor,
} from './infra/repo.js'

/**
 * 内联进 prompt 的 diff 行数上限。
 *
 * 实测内联 2000 行会把评审 prompt 顶到 9 万字（90068 字、37.6s/步），
 * 而评审要看的是改动分布和关键片段；截断后配文件清单 + 按需 git diff
 * 更省上下文。改这个值等于改评审回合的成本，别随手调大。
 */
const DIFF_MAX_LINES = 600

/**
 * 把 git diff 裁成「改动文件清单 + 截断后的正文」。
 *
 * 单独拎出来是为了能单测：截断与否只看行数，和是谁的回合无关。
 * 超限时附一句怎么按文件取，比只写「已截断」有用——评审要细看某处时
 * 知道该跑 `git diff -- <文件>`，而不是试图整份重读。
 */
export function capDiff(raw) {
  const text = String(raw ?? '')
  // 从 diff 头里取目标路径：diff --git a/x b/y 里的 b/y 才是改动后的文件
  const files = [...new Set(
    [...text.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]),
  )]
  const lines = text.split('\n')
  const tooLong = lines.length > DIFF_MAX_LINES
  return {
    changedFiles: files.length ? files.join('、') : '（无法从 diff 解析出文件名）',
    diff: tooLong
      ? `${lines.slice(0, DIFF_MAX_LINES).join('\n')}\n`
        + `（diff 超过 ${DIFF_MAX_LINES} 行已截断：先看上面的改动文件清单，`
        + '需要细看某个文件时用 git diff -- <文件> 单独取，不要整份重读）'
      : text,
  }
}

/**
 * 需求唯一标识：随机 8 位。
 *
 * 以前用需求文本里提的英文词当 id，问题是两个群提相似需求就会撞车，
 * 后一个写进前一个的目录把产物覆盖掉。唯一性必须和文本内容无关。
 * 给人看的名字另外存 flow.name，只出现在群消息和编排记录里。
 */
export function makeReqId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz023456789' // 去掉 l/o/1 这种易混字符
  let id = ''
  for (let i = 0; i < 8; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
  return id
}

/** 给人看的名字：需求原文截一段，不参与任何路径和分支命名 */
export function makeReqName(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  return t.slice(0, 30) || '未命名需求'
}

/**
 * 把配置里的 toolPaths 追加到子进程 PATH 前面。
 *
 * spawn 的 env 是整体替换，bridge 自己继承到的 PATH 未必包含 git/flutter/adb
 * （Windows 上尤其常见：这些工具装在自定义目录，只有用户会话的 PATH 有）。
 * 回合里跑不了 git 的症状是 spawnSync ENOENT，agent 只能瞎猜原因。
 * toolPaths 是目录数组，存在才加——不存在的路径塞进 PATH 只会拖慢查找。
 */
export function withToolPaths(env, toolPaths) {
  if (!Array.isArray(toolPaths) || !toolPaths.length) return env
  const exists = toolPaths.filter((p) => p && existsSync(p))
  if (!exists.length) return env
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...env, PATH: [...exists, env.PATH ?? ''].join(sep) }
}

/**
 * 环境前置探测：回合真正开始前确认 git 在 bot 进程的 PATH 里。
 *
 * dev/test/acceptance 的 agent 都要跑 git（dev 靠 git diff 验产出，merge 直接
 * 操作分支），git 不在 PATH 时每个回合都烧满重试次数才停下来——4 次 0 秒失败
 * 的问题模式就是这样（spawnSync ENOENT，agent 只能瞎猜）。在这里拦住，一眼
 * 告诉用户去哪加 PATH，一轮都不用烧。返回 null 表示环境正常。
 */
export function preflightGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (r.error?.code === 'ENOENT') {
    return {
      ok: false,
      error:
        '环境检查没过：bot 进程的 PATH 里找不到 git。' +
        '把 Git 的 cmd 目录（如 C:\\Program Files\\Git\\cmd）加进系统 PATH 后重启 bot，' +
        '或改用配置里的 toolPaths 追加。',
    }
  }
  if (r.error) return { ok: false, error: `环境检查没过：git --version 执行失败：${r.error.message}` }
  if (r.status !== 0) return { ok: false, error: `环境检查没过：git --version 退出码 ${r.status}` }
  return { ok: true }
}

/**
 * 设备预热：lease 拿不到时，找一台匹配平台的离线模拟器启动，等它 running 再租。
 *
 * 三步都可能失败，但失败的原因不同：start 失败（镜像损坏/端口占用）不值得
 * 重试；启动后等不到 running 是慢不是坏，多等几轮；最终 lease 再失败就把
 * 错误交回去，走原来的「启动一台模拟器后回复继续」提示。
 * 总预算 3 分钟：模拟器冷启动通常 30~90 秒，超了大概率是真有问题。
 */
export async function warmupAndLease(emulator, { reqId, stage, platform, log = () => {}, maxWaitMs = 180_000 }) {
  const listed = await emulator.list({ platform })
  const candidates = (listed.items ?? []).filter((d) => !d.running)
  if (!listed.ok || !candidates.length) {
    return { ok: false, error: '没有可预热的离线模拟器' }
  }
  const name = candidates[0].name
  log(`设备预热：启动模拟器 ${name}`)
  const started = await emulator.start(name, { platform })
  if (!started.ok) return { ok: false, error: `启动模拟器 ${name} 失败：${started.error}` }

  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    const again = await emulator.list({ platform })
    const dev = (again.items ?? []).find((d) => d.name === name)
    if (dev?.running) {
      log(`模拟器 ${name} 已启动，重新申请租约`)
      return emulator.lease({ reqId, stage, platform })
    }
  }
  return { ok: false, error: `模拟器 ${name} 启动超过 ${Math.round(maxWaitMs / 1000)}s 仍未就绪` }
}

/** 把回执里的 decisions 渲染成给人看的列表（替代旧的 [[ASK]] JSON 渲染） */
export function formatDecisions(decisions) {
  return (decisions ?? [])
    .map((d, i) => {
      const opts = (d.options ?? []).map((o, j) => {
        const key = String.fromCharCode(65 + j)
        return `   ${key}. ${optionLabel(o.text, o.recommended)}`
      })
      return [`${i + 1}. ${d.q}`, ...opts].join('\n')
    })
    .join('\n')
}

/**
 * 把「等用户拍板」变成一张提问卡片，直接进消息流。
 *
 * 以前是发一段「1. xx  A. yy」的纯文本，用户得在输入框里手打字母，
 * 打错一位 agent 就理解成别的选项。卡片上勾选没有这个问题；
 * 手机上一屏能点完，也不用记着「第几个问题对应哪个字母」。
 *
 * @param {Array} decisions agent 回执里的待决策项（没有就退化成「通过/打回」）
 * @param {string} confirmTitle 通过/打回卡片的标题
 * @param {string} [decisionsTitle] agent 这次调用自己起的总标题；没给就沿用固定文案
 */
export function askPayloadFor(decisions = [], confirmTitle = '', decisionsTitle = '') {
  const list = (Array.isArray(decisions) ? decisions : [])
    .filter((d) => d && String(d.q ?? '').trim())

  if (list.length) {
    return {
      // 标题跟着每次调用走：不同阶段问的事不一样，「需要你拍板」这种
      // 万金油文案让人分不清这是哪一轮的问题，agent 报了就用 agent 的。
      title: String(decisionsTitle ?? '').trim() || '需要你拍板',
      submitLabel: '提交',
      questions: list.map((d, i) => ({
        id: `q${i + 1}`,
        title: String(d.q).trim(),
        kind: 'single',
        // 选项之外常常还有「都不是，我要的是…」。不给这个口子，用户只能
        // 挑一个将就的，agent 拿到的是错的需求，还以为是用户本意。
        allowInput: true,
        inputLabel: '都不是？自己写',
        options: (d.options ?? [])
          .filter((o) => o && String(o.text ?? '').trim())
          .map((o, j) => ({
            id: String.fromCharCode(97 + j),
            label: optionLabel(o.text, o.recommended),
          })),
      })),
    }
  }

  return {
    title: confirmTitle || '确认一下',
    submitLabel: '提交',
    questions: [
      {
        id: 'confirm',
        title: '本轮是否通过？',
        kind: 'single',
        allowInput: true,
        inputLabel: '打回理由（选「打回」时填）',
        options: [
          { id: 'approve', label: '通过' },
          { id: 'reject', label: '打回' },
        ],
      },
    ],
  }
}

/**
 * @param {object} deps
 *   config, store, machine, log, sendPlain, runTurn, transport, modelEnv, repoRoot
 */
/** 群 → 已持有的合并锁。回合结束（或失败）时释放 */
const mergeLocks = new Map()
/** 群 → 已持有的 worktree 槽。合并收尾时释放 */
const worktreeSlots = new Map()
/** 群 → 已占用的设备。阶段结束释放 */
const deviceSlots = new Map()

export function createFlowBridge(deps) {
  const { config, store, machine, log, sendPlain, runTurn, transport, modelEnv, repoRoot, gitDiff } = deps

  // 图片和文件走 transport（落成产物文件给 URL）。
  // 没注入时退化成空实现：老测试只关心文本播报，不该为了几张图去造 store。
  const tx = transport ?? {
    sendImage: () => {},
    sendFile: () => {},
    event: () => {},
  }

  // 两层并发闸门，都落在磁盘上（进程崩了占位会按 pid 自动清理）：
  //   worktree 池 —— 同时处于开发期的需求数，决定磁盘占用
  //   执行槽     —— 同时跑的回合数，决定内存和 token 消耗
  const poolsRoot = join(config.repoDir, '..', 'pools')
  const worktreePool = new SlotPool(join(poolsRoot, 'worktree'), config.limits?.maxWorktrees ?? 12)
  const turnPool = new SlotPool(join(poolsRoot, 'turn'), config.limits?.maxConcurrentTurns ?? 2)
  // 设备归模拟器服务管：编排层只申请/释放，不碰具体设备也不读平台配置。
  // 允许注入，测试就不必真的起一个服务。
  const emulator = deps.emulator ?? createEmulatorClient(config)
  // 平台是「这条需求的仓库」的属性，不是全局属性：一个团队里鸿蒙、安卓仓库
  // 并存时，按第一个仓库算会把安卓需求当成鸿蒙去构建、去租设备（实测踩过）。
  const repoFor = (flow) => {
    const repos = config.repos ?? []
    const id = flow?.repoId ?? config.primaryRepo?.id ?? null
    return repos.find((r) => r.id === id) ?? config.primaryRepo ?? null
  }
  const platformFor = (flow) => platformOf(repoFor(flow))
  // 合并脚本可替换：单测里真跑 git 会把夹具仓库推歪（跨用例串味），
  // 所以生产默认真实现、测试显式换桩或整个关掉。
  const mergeScriptImpl = deps.runMergeScript ?? runMergeScript
  const scriptedMerge = deps.scriptedMerge !== false
  const skillsDir = join(repoRoot, 'skills')
  const templates = config.messageTemplates
  // 测试可以注入假 diff；生产环境读真 git
  // dev 阶段会自己 commit，提交完之后工作区是干净的，`git diff` 就是空的。
  // 所以要把「feature 分支相对主分支的差异」也算进来，否则改动明明在、校验却判没产出。
  const readGitDiff = gitDiff ?? ((dir) => {
    const main = detectMainBranch(dir)
    const committed = gitRun(dir, ['diff', `${main}...HEAD`]).out
    const uncommitted = gitRun(dir, ['diff', 'HEAD']).out
    const staged = gitRun(dir, ['diff', '--cached']).out
    return [committed, uncommitted, staged].filter(Boolean).join('\n')
  })

  /**
   * 入口。调用方已经做完权限校验。
   */
  async function handleMessage({ groupId, text, replyTo, st, initiator, can, answers = null }) {
    // 安全指令：v2 下只保留打断和释放，其余斜杠指令在老流程里
    const cmd = parseCommand(text)
    if (cmd?.name === 'stop') {
      const killed = machine.interrupt(groupId)
      await sendPlain(groupId, killed ? '已打断当前回合。' : '当前没有在跑的任务。', { replyTo })
      return
    }
    if (cmd?.name === 'release') {
      machine.interrupt(groupId)
      store.clear(groupId)
      await sendPlain(groupId, '已释放会话与进程。进度保留在项目目录里，重新说需求就能接上。', { replyTo })
      return
    }
    if (cmd?.name === 'help') {
      await sendPlain(
        groupId,
        [
          '直接 @我 说需求，比如：首页加个欢迎弹窗。',
          '我在等确认时，回你的答复或「通过 / 打回 <意见>」。',
          '/stop 打断当前回合，/release 释放会话。',
        ].join('\n'),
        { replyTo },
      )
      return
    }

    // 运行中插话：排队，不打断当前回合（两个回合抢写同一份文档是老问题）
    if (machine.isRunning(groupId)) {
      machine.enqueue(groupId, text)
      await sendPlain(groupId, renderMessage('v2Queued', {}, templates), { replyTo })
      return
    }

    const flow = st.flow ?? null

    // 没绑需求：v2 不再从群消息起需求。目标仓库要显式选（App 的「新需求」弹窗），
    // 靠需求文本猜仓库一旦猜错，整条需求会跑在错的仓库上，等发现时已经烧掉几十分钟。
    if (!flow) {
      // 旧版（v1）绑过需求的群，v2 不接管——否则会把已有需求当成新需求重开，
      // 用新生成的 reqId 另起一个目录，旧进度的归属就乱了。
      // 判据是「有 reqId 但没有 flow」：v2 新建时两者同时写，不会出现这种组合。
      if (st.reqId) {
        await sendPlain(
          groupId,
          [
            `这个群在旧版里绑着需求 ${st.reqId}，v2 不接管已有需求。`,
            '换一个没跑过需求的群试，或先备份再清掉 .state/group-<群号>.json。',
          ].join('\n'),
          { replyTo },
        )
        return
      }
      await sendPlain(groupId, renderMessage('v2NeedRequirement', {}, templates), { replyTo })
      return
    }

    // 已跑完：一个群一个需求，做完仍占着这个群（和 v1 的口径一致）
    if (flow.status === 'done') {
      await sendPlain(groupId, renderMessage('v2Done', { name: flow.name ?? flow.reqId }, templates), { replyTo })
      return
    }

    // 进程崩溃/重启后残留的 running：没有实际回合在跑（否则前面排队分支就拦了），
    // 但不能静默吞掉用户消息，也不能让「继续」陷入「再提示一次」的死循环。
    if (flow.status === 'running') {
      const cp = currentCheckpoint(flow)
      if (/^(继续|接着跑|重试|retry)$/i.test(String(text ?? '').trim())) {
        return runFromState({ groupId, st, replyTo })
      }
      await sendPlain(
        groupId,
        // 同上：纯文本进不了引擎，提示必须带上 @（router 只认 @bot）
        `上次回合异常中断，停在「${cp?.label ?? flow.current}」。@我 发「继续」重跑这一步。`,
        { replyTo },
      )
      return
    }

    // 等用户回答/拍板
    if (flow.status === 'waiting_user') {
      // commit 的等待是「要不要提交」，不是对 agent 提问的回答
      return answerWaiting({ groupId, text, replyTo, st, initiator, answers })
    }

    // 卡住了：用户给一句话就接着试（重置本轮计数，但不重置历史轮次）
    if (flow.status === 'blocked') {
      return retryBlocked({ groupId, text, replyTo, st })
    }
  }

  /**
   * 新建需求。仓库由调用方显式传入（App 的「新需求」弹窗里选的），这里不猜：
   * 猜错了整条需求会跑在错的仓库上，等发现时已经烧掉几十分钟。
   *
   * 返回 {ok, reqId, name} 让调用方立刻回执；回合本身异步跑，建完就不占着请求。
   */
  async function createRequirement({ groupId, text, name, repoId, replyTo, st, initiator }) {
    // 一个群只服务一条需求：交付完也不在同一个群里再开一单，否则群消息里
    // 会并排躺着两张需求卡片，追问和拍板都不知道挂在谁身上。
    if (st.flow?.reqId) {
      return { ok: false, error: `这个群已经有需求了（${st.flow.reqId}），换一个群发起新需求` }
    }

    const repos = config.repos ?? []
    if (!repos.length) return { ok: false, error: '还没有配置项目仓库，请先在管理面板的「项目」页添加一个' }
    // 只有一个仓库时允许不传 repoId（省得前端非要选一次），多仓库必须指定
    const repo = repos.find((r) => r.id === repoId) ?? (repos.length === 1 ? repos[0] : null)
    if (!repo) return { ok: false, error: `没有这个项目仓库：${repoId || '（未指定）'}` }
    if (!String(text ?? '').trim()) return { ok: false, error: '需求内容是空的' }

    // 随机 8 位标识，和名称无关——两个人提相似需求也不会撞目录
    const reqId = makeReqId()
    st.projectDir = repo.path
    // 暂存区建在项目内：子进程沙箱只能写会话工作区。
    // 用本地 exclude 忽略它，接入方不需要改 .gitignore。
    ensureScratchIgnored(st.projectDir)
    const dataDir = join(st.projectDir, '.qq-bot-scratch', reqId)
    try {
      mkdirSync(dataDir, { recursive: true })
    } catch (err) {
      return { ok: false, error: `创建需求目录失败：${err.message}` }
    }

    const reqName = String(name ?? '').trim() || makeReqName(text)
    const flow = {
      ...initialState({
        reqId,
        name: reqName,
        projectDir: st.projectDir,
        // 产物落在项目内的 docs/requirements/<reqId>/：dsh 子进程的沙箱限制在工作区，
        // 写到外面会被拒绝（见 reqDirOf 的注释）。
        dataDir,
        repoDir: repo.repoDir,
      }),
      requestText: text,
      vars: {},
      roleSessions: {},
      // 仓库记在需求上：后面每一处「按平台构建/租设备/建工作区」都读它，
      // 不再回落到「配置里第一个仓库」。
      repoId: repo.id,
      repoName: repo.name,
    }

    st.flow = flow
    st.reqId = reqId
    if (initiator) st.initiator = initiator
    store.save(groupId, st)

    // 发起记录落成卡片：群里留着「这条需求是什么、跑在哪个 app」，App 端也有结构可渲染
    tx.event(groupId, 'requirement', {
      reqId,
      name: reqName,
      text,
      repo: { id: repo.id, name: repo.name, platform: platformOf(repo).id },
    })
    await sendPlain(groupId, renderMessage('v2Kickoff', { name: reqName }, templates), { replyTo })
    // 不等回合跑完：HTTP 请求要立刻拿到 reqId，进度靠群消息和状态文件看。
    // started 一并返回是给测试用的——它要能 await 到这一轮回合结束，
    // 生产调用方直接忽略（JSON 序列化前线程层只取 reqId/name）。
    const started = runFromState({ groupId, st, replyTo }).catch((err) => {
      log(`[${groupId}] 需求 ${reqId} 回合异常：${err?.message ?? err}`)
    })
    return { ok: true, reqId, name: reqName, started }
  }

  /**
   * 这条回答是不是确认卡上的「打回」。
   *
   * 结构化答案优先（App 会把选中的 optionIds 带上来）；纯文本兜底是因为
   * 确认卡只有一题时用户可能直接打字「打回：xxx」，不能让两种入口语义不同。
   */
  function isRejectAnswer(waiting, text, cards) {
    if (!waiting?.approve) return false
    const picked = (Array.isArray(cards) ? cards : []).flatMap((a) => a?.optionIds ?? [])
    if (picked.includes('reject')) return true
    if (picked.includes('approve')) return false
    return /打回/.test(String(text ?? ''))
  }

  async function answerWaiting({ groupId, text, replyTo, st, initiator, answers = null }) {
    const flow = st.flow
    // 用户这句话既是「对等待事项的回答」，也可能是修改意见；先原样存进 vars，
    // 由该阶段的 agent 自己判断怎么用（bridge 不做语义猜测）。
    // 上一轮 agent 提的问题也要存下来——否则「AA」这种回答会被拿去和
    // 《待提问清单》（需求澄清阶段的旧清单）比对，永远对不上。
    const prevDecisions = flow.waiting?.decisions ?? []
    // 卡片上勾选的结果也一起留着：只有它能无歧义地还原「第 2 题选了 B」，
    // 纯文本那句「我要的是第三个」agent 常常理解偏。
    const cards = (Array.isArray(answers) ? answers : []).filter((a) => a && a.qid)
    // 打回不等于放行：闸门上点了打回，就重跑这一阶段，把理由交给它自己改
    const rejected = isRejectAnswer(flow.waiting, text, cards)
    const decided = rejected ? reworkFromUser(flow, text) : { state: resumeFromUser(flow), action: 'advance' }
    if (decided.action === 'blocked') log(`[${groupId}] ${decided.reason}`)
    const answered = {
      ...decided.state,
      vars: {
        ...flow.vars,
        userAnswer: text,
        lastDecisions: prevDecisions,
        answerCards: cards.length ? cards : null,
        ...(decided.action === 'rework'
          ? { rework: { checkpointId: flow.waiting?.checkpointId ?? null, reason: String(text ?? '').trim(), at: Date.now() } }
          : {}),
      },
      // 审计：谁在哪个阶段点的确认。发起人可能不是确认人，
      // 团队里需要能追「这一步是谁放行的」。
      confirmer: {
        // 用「这次说话的人」而不是 st.initiator（那是发起需求的人）——
        // 团队里发起人和确认人本来就可以不是同一个
        userId: initiator?.userId ?? null,
        nickname: initiator?.nickname ?? null,
        at: Date.now(),
        stage: flow.current,
      },
    }
    st.flow = answered
    store.save(groupId, st)
    // 打回到上限就停在 blocked：这时候再 runFromState 会把同一个阶段又跑一遍
    if (decided.action === 'blocked') {
      await sendPlain(groupId, renderMessage('v2Blocked', { reason: decided.reason }, templates), { replyTo }).catch(() => {})
      return
    }
    await runFromState({ groupId, st, replyTo })
  }

  async function retryBlocked({ groupId, text, replyTo, st }) {
    const flow = st.flow
    // 卡住时用户给了指示：清掉当前 checkpoint 的返工计数重新试一轮，
    // 但保留其他 checkpoint 的历史——总量仍然受 MAX_RETRY 约束。
    const rounds = { ...flow.rounds }
    delete rounds[flow.waiting?.checkpointId ?? flow.current]
    const next = {
      ...flow,
      status: 'running',
      waiting: null,
      rounds,
      vars: { ...flow.vars, userAnswer: text },
    }
    st.flow = next
    store.save(groupId, st)
    await runFromState({ groupId, st, replyTo })
  }

  /** 起一轮连续推进，直到状态机需要停下 */
  async function runFromState({ groupId, st, replyTo }) {
    const aborter = new AbortController()
    const release = machine.acquire(groupId, aborter)
    if (!release) return

    const flow = st.flow
    const reqDir = reqDirOf(flow)
    try {
      mkdirSync(reqDir, { recursive: true })
    } catch {
      /* 目录已存在或建不了，后面校验会给出明确错误 */
    }

    const heartbeat = startHeartbeat({ groupId, st, replyTo })

    try {
      const result = await runFlow({
        flow,
        ctx: buildCtx({ groupId, st, replyTo, reqDir, aborter }),
      })
      st.flow = result.flow
      store.save(groupId, st)
      await announceStop({ groupId, replyTo, result, st })
    } catch (err) {
      log(`[${groupId}] v2 流程异常：${err.message}`)
      // 状态留在原地，用户发「继续」就能重试——不要清成 {}，那会丢掉进度
      await sendPlain(
        groupId,
        renderMessage('abnormal', { reason: err.message }, templates),
        { replyTo },
      ).catch(() => {})
    } finally {
      clearInterval(heartbeat)
      release()
      drainQueue({ groupId })
    }
  }

  function buildCtx({ groupId, st, replyTo, reqDir, aborter }) {
    // 评审链（review/re-review/fix）的输入里带 <changedFiles>/<diff>：
    // 直接把真实 diff 喂进 prompt，agent 不用自己跑 git（实测能省下小十分钟摸排）。
    // 截断是防大 diff 撑爆 prompt；超限就让 agent 自己看完整版。
    const ctxReviewDiff = (flow) => {
      // 只对评审链算——其他阶段 input 里没有这两个占位符，
      // 而且需求澄清阶段还没有工作区，跑 git 只会拿到一堆错误。
      if (!['review', 're-review', 'fix'].includes(flow.current)) return { changedFiles: '', diff: '' }
      const dir = flow.workDir || st.projectDir
      const raw = readGitDiff(dir)
      if (!raw) return { changedFiles: '（无改动）', diff: '（无改动）' }
      return capDiff(raw)
    }
    // 设计阶段的 <screenshots>：给实文件清单而不是目录名——
    // agent 拿目录名还得自己 ls，目录不存在时更是白跑一轮。
    const listReferenceShots = (dir) => {
      const out = []
      for (const sub of ['docs/ui-screenshots', 'docs/ui-compare']) {
        const abs = join(dir, sub)
        try {
          for (const f of readdirSync(abs)) {
            if (/\.(png|jpg|jpeg|webp)$/i.test(f)) out.push(`${sub}/${f}`)
          }
        } catch {
          // 目录不存在就跳过——新项目第一版没有截图库是常态
        }
      }
      return out.length ? out.join('\n') : '（没有参照截图，按新页面处理）'
    }
    return {
      skillsDir,
      reqDir,
      // 产物目录会随 dev 起变（暂存区 → 工作区）。flow-runner 每轮开始时用
      // 这个函数重新取一次，回执和产物校验才跟 agent 实际的目录对齐——
      // 固定用 runFromState 时算的那份（进流程前工作区还不存在，只能是暂存区）
      // 实测会把 dev 之后的回执/校验全部落在暂存区，和 agent 的产物分家。
      reqDirOf: (flow) => reqDirOf(flow),
      // merge 回执兜底：agent 在合并工作区里跑，回执可能写偏（写在工作区根
      // 或合并工作区的需求目录）。正规目录读不到时先搬回再读——不然明明
      // 合并完了却报「没写回执」（实测踩过两次）。
      beforeReadReceipt: (flow, checkpointId) => recoverMergeReceipt(flow, checkpointId),
      // dev 之后代码改动都在工作区，看主项目的 diff 只会是空
      gitDiff: () => readGitDiff(st.flow.workDir || st.projectDir),
      // 群配置是手动批准时，每个阶段的产物都停下来等人点头
      requireApproval: config.approval === 'manual',
      persist: (flow) => {
        st.flow = flow
        store.save(groupId, st)
        // 编排记录跟着状态走一次：面板和人都看这份，不需要谁去解析它。
        // 但已经收尾（done）的不写——收尾清理刚把工作区删掉，
        // 这里再写一次会把目录重新建出来，留下一棵只有编排记录的空树。
        if (flow.status !== 'done') writeBoard(reqDirOf(flow), flow)
      },
      varsFor: (cp, flow) => ({
        // merge 回合的 agent 跑在合并工作区（cwd=_merge），reqDir 必须指到
        // 合并工作区里的需求目录：回执、文档归档都写在这里，engine 读回执
        // 的目录和 agent 写的目录才是同一个。指到开发工作区的话（实测踩过
        // 两次）agent 会把回执写到 _merge 根目录或别处，bot 读不到，
        // 「明明合并完了却报没写回执」。
        reqDir:
          cp.id === 'merge' && flow.vars?.mergeWorkDir
            ? join(flow.vars.mergeWorkDir, 'docs/requirements', flow.reqId) + '/'
            : reqDirOf(flow) + '/',
        userRequest: flow.requestText ?? '',
        userAnswer: flow.vars?.userAnswer ?? '',
        // 用户回答单独成段，并且尽量和问题编号对齐——直接塞进「输入文件清单」里，
        // agent 会把它当成一个文件名或占位符去猜（实测：它数了字母个数，怀疑是乱码）。
        answerBlock: buildAnswerBlock(
          reqDirOf(flow),
          flow.vars?.userAnswer,
          flow.vars?.lastDecisions,
          flow.vars?.answerCards,
        ),
        // 代码工作区：dev 之后才有；之前的阶段不传，避免 agent 去找一个不存在的目录
        // merge 阶段在专用工作区里操作；其他阶段用需求自己的工作区
        workDir: (flow.current === 'merge' ? flow.vars?.mergeWorkDir : flow.workDir) ?? flow.workDir ?? '',
        deviceId: flow.vars?.deviceId ?? '',
        platform: platformFor(flow).id,
        // 平台命令块：构建/测试/装包怎么跑，由适配器决定
        platformBlock: buildPlatformBlock(platformFor(flow), {
          deviceId: flow.vars?.deviceId ?? '<设备ID>',
          artifactId: flow.vars?.artifactId ?? guessArtifactId(st.projectDir),
        }),
        dataDir: reqDirOf(flow),
        // 目录树给对地方：dev 之后看工作区，之前看主仓库
        projectTree: listTop(flow.workDir ?? st.projectDir),
        changedFiles: ctxReviewDiff(flow).changedFiles,
        diff: ctxReviewDiff(flow).diff,
        debugPackage: flow.vars?.debugPackage ?? '',
        // 参照截图给实文件清单，不给目录名——agent 拿着目录名还得自己 ls 一轮，
        // 而且目录可能不存在（新项目第一版）；空串让占位符提示「没有参照截图」
        screenshots: listReferenceShots(st.projectDir),
        // 自带渲染器所在目录（设计阶段用）：skill 正文会被内联进 prompt，
        // 但 agent 不知道 skill 装在哪——指路变量替它把绝对路径带上
        skillAssets: join(skillsDir, cp.role, 'assets'),
        testAccount: '',
        mergeInfo:
          `feature 分支：${flow.vars?.featureBranch ?? `feature/${flow.reqId}`}\n` +
          `主分支：${flow.vars?.mainBranch ?? (() => { try { return detectMainBranch(st.projectDir) } catch { return 'main' } })()}\n` +
          // 合并验证由 bridge 先算好（mergeFastForward），agent 只执行结论：
          // 它自己现算容易漏看 main 的动向，算错一次 main 就是没验证过的树
          (flow.vars?.mergeFastForward === true
            ? '验证要求：main 自分支切出后没有新提交，合并结果的代码树与测试阶段验证过的分支完全一致——直接合并推送，跳过编译和单元测试。'
            : '验证要求：main 在分支开发期间有新提交，合并出的是没人验证过的新树——合并后必须跑编译和单元测试，全绿再推送。'),
        // 合并回合的文档归档源：dev 全程的文档躺在开发工作区（没有随代码提交），
        // prompt 不指路的话 agent 只会合并分支，docs 永远进不了主仓库。
        docsSourceDir: reqDirOf(flow),
      }),
      onCheckpointStart: async (cp) => {
        // 记下阶段开始时刻，心跳要报「这一阶段已经跑了多久」。
        // 放在 bridge 而不是 flow.js：状态机是纯函数，不碰时间。
        // 就地改 st.flow（不换对象引用）：runner 手里的 state 和它是同一个
        // 对象，一旦换成新对象，回合结束 advance 后 persist 会用旧对象把
        // 这里的 workDir/vars 全部抹掉——实测 wrapup 时工作区信息凭空消失
        // 就是这个原因（review/merge 的 agent 还因此被丢进没代码的主目录）。
        st.flow.checkpointStartedAt = Date.now()
        store.save(groupId, st)
        // 回合要跑 git 的阶段先探一下环境。放到这里而不是启动时：git 缺失
        // 通常发生在服务跑了一阵之后（改 PATH/换机器），启动时探过不代表
        // 现在还有。失败直接抛——bridge 会把人话错误发给群并停在 blocked，
        // 一轮 agent 都不用烧。
        if (cp.verify === 'gitDiff' || cp.id === 'merge' || cp.needsDevice) {
          const env = preflightGit()
          if (!env.ok) throw new Error(env.error)
        }
        // 开发阶段建一个独立工作区（worktree）。这一步是团队化的核心：
        // 所有需求共用主工作区时，两个需求的 dev 会互相 checkout 打断对方，
        // 而且没有任何报错——代码就写到了错误的分支上。worktree 让每个需求独占一个目录。
        // 需要设备（模拟器/真机）的阶段先抢一台。设备是独占资源：
        // 两个回合同时往同一台设备装包，会出现「包被覆盖」「测试跑到别人的版本上」
        // 这类极难排查的问题，而且完全没有报错。
        if (cp.needsDevice && !deviceSlots.has(groupId)) {
          // 带平台：安卓需求不该拿到鸿蒙模拟器
          let granted = await emulator.lease({
            reqId: st.flow.reqId,
            stage: cp.id,
            platform: platformFor(st.flow).id,
          })
          // 没有运行中的设备时先预热再租：服务上有配好的但关着的模拟器，
          // 直接把错误甩给用户要人去点启动，一轮就耗十几分钟。启动一台
          // 匹配平台的、等它 running、重新租——全程对用户无感。
          if (!granted.ok && !granted.offline) {
            granted = await warmupAndLease(emulator, {
              reqId: st.flow.reqId,
              stage: cp.id,
              platform: platformFor(st.flow).id,
              log: (m) => log(`[${groupId}] ${m}`),
            })
          }
          if (!granted.ok) {
            throw new Error(
              `「${cp.label}」需要设备，但模拟器服务没给：${granted.error}` +
                (granted.offline ? '（启动 node src/emulator-service.js）' : '（启动一台模拟器后回复「继续」）'),
            )
          }
          deviceSlots.set(groupId, { deviceId: granted.deviceId })
          st.flow.vars = { ...st.flow.vars, deviceId: granted.deviceId }
          store.save(groupId, st)
          log(`[${groupId}] 已租到设备 ${granted.deviceId}${granted.reused ? '（复用）' : ''}`)
        }

        // 合并阶段用一个全局唯一的专用工作区，配合文件锁串行——
        // 如果在需求自己的工作区里 checkout 主分支，那条工作区就被污染了，
        // 而如果各自在主仓库合并，两个需求会互相打断。
        if (cp.id === 'merge') {
          const mainBranch = st.flow.vars?.mainBranch ?? detectRepoMainBranch(st.projectDir)
          const mw = ensureMergeWorktree({
            repoDir: config.repoDir,
            worktreeRoot: config.worktreeRoot,
            mainBranch,
          })
          if (!mw.ok) throw new Error(`准备合并工作区失败：${mw.error}`)

          // 合并是全局串行操作：两个需求同时验收通过时，不能让它们同时改主分支。
          // 拿不到锁就等，等到再进——回合本身还没开始，等待是安全的。
          const lockFile = join(config.repoDir, '..', 'merge.lock')
          const waitMs = config.limits?.mergeLockWaitMs ?? 30 * 60 * 1000
          const lock = await acquireLock(lockFile, { waitMs, pollMs: 200 })
          if (!lock.ok) throw new Error('等待合并锁超时：另一个需求正在合并')

          // 同理就地改：mergeWorkDir 要活着传给本回合的 varsFor 和 cwd
          st.flow.vars = { ...st.flow.vars, mergeWorkDir: mw.path, mergeLockFile: lockFile }
          // 合并工作区是复用的（reset --hard 不清 untracked 文件）：上一需求的
          // _receipt-merge.json 会留下来，本回合 agent 没写回执时会读到旧文件
          // 误判通过——回合开始前先清掉本阶段的旧回执。
          const oldReceipt = join(mw.path, receiptFile(cp.id))
          try { rmSync(oldReceipt, { force: true }) } catch { /* 不存在就算了 */ }
          // 合并要不要重新验证，现在就能定：main 自分支切出后没动过（fast-forward）
          // 时，合并结果的代码树和测试阶段刚验证过的分支逐字节一致，再跑编译单测
          // 是纯重复；main 有新提交时三方合并出的是没人测过的新树（语义冲突文本
          // 上看不出来），必须跑。判据算错时宁可多测：取 false。
          // feature 分支的对象不在裸仓库（worktree 自带 .git），要从开发工作区
          // fetch 进合并工作区再比；开发工作区丢了就按「需要验证」处理。
          const devDir = st.flow.workDir ?? st.flow.vars?.workDir ?? ''
          const verifyBranch = st.flow.vars?.featureBranch ?? `feature/${st.flow.reqId}`
          let mergeFF = false
          let ffNote = '开发工作区不可用，保守起见需要验证'
          if (devDir) {
            const fetched = gitRun(mw.path, ['fetch', '--no-tags', devDir, verifyBranch])
            const behind = fetched.ok
              ? gitRun(mw.path, ['rev-list', '--count', `FETCH_HEAD..${mainBranch}`])
              : { ok: false, error: fetched.error }
            if (behind.ok) {
              mergeFF = behind.out === '0'
              ffNote = mergeFF ? '没有新提交，跳过编译单测' : `有新提交（${behind.out} 个），需跑编译单测`
            } else {
              ffNote = `判定失败（${behind.error}），保守起见需要验证`
            }
          }
          st.flow.vars.mergeFastForward = mergeFF
          store.save(groupId, st)
          log(`[${groupId}] 合并验证判据：main 自分支切出后${ffNote}`)
          // 锁在回合结束后释放（onCheckpointEnd 里），中途崩溃则由锁的僵尸检测兜底
          mergeLocks.set(groupId, lock)
          log(`[${groupId}] 合并工作区：${mw.path}（已取得合并锁）`)
        }

        if (cp.id === 'dev') {
          // 先抢一个 worktree 名额。池满时等待——磁盘装不下更多并行开发，
          // 硬塞进去只会把机器拖垮，不如排队并告诉用户前面还有几个。
          if (!worktreeSlots.has(groupId)) {
            const slot = await worktreePool.acquire({
              waitMs: 60 * 60 * 1000,
              pollMs: 1000,
              tag: st.flow.reqId,
            })
            if (!slot) throw new Error('等待工作区名额超时（一小时）')
            worktreeSlots.set(groupId, slot)
            const stats = slot.stats()
            log(`[${groupId}] 已分配工作区名额 ${stats.used}/${stats.max}`)
          }

          // 涉及哪些仓库：默认只有主仓库；技术方案回执里声明了才扩展
          // （组件化项目：改组件库要同时给那个仓库开工作区）
          // 默认只开这条需求自己的仓库；技术方案回执里声明了 repos 才扩展
          const repoIds = st.flow.repos?.length ? st.flow.repos : [st.flow.repoId ?? config.primaryRepo.id]
          const workspaces = { ...(st.flow.workspaces ?? {}) }
          let primaryWt = null

          for (const repoId of repoIds) {
            const repoCfg = config.repos.find((r) => r.id === repoId)
            if (!repoCfg) throw new Error(`技术方案里声明的仓库未配置：${repoId}`)

            const mainBranch =
              config.mainBranch || detectRepoMainBranch(repoCfg.path)
            // 远端地址优先级：仓库自己配的 > 全局 remoteUrl（单仓库场景）> 从仓库路径的 origin 推断
            const repo = ensureBareRepo({
              repoDir: repoCfg.repoDir,
              remoteUrl: repoCfg.remoteUrl || repoCfg.url || config.remoteUrl || remoteUrlOf(repoCfg.path),
              mainBranch,
            })
            if (!repo.ok) throw new Error(`初始化裸仓库失败（${repoId}）：${repo.error}`)

            const wt = createWorktree({
              repoDir: repoCfg.repoDir,
              worktreeRoot: repoCfg.worktreeRoot,
              reqId: st.flow.reqId,
              mainBranch: repo.mainBranch,
            })
            if (!wt.ok) throw new Error(`创建工作区失败（${repoId}）：${wt.error}`)

            workspaces[repoId] = {
              path: wt.path,
              branch: wt.branch,
              repoDir: repoCfg.repoDir,
              mainBranch: repo.mainBranch,
            }
            // 主工作区是「这条需求的仓库」的那个，不是配置里排第一的那个：
            // 多仓库时用户可能选第二个仓库，按 primary 标记判会直接抛错。
            if (repoId === (st.flow.repoId ?? config.primaryRepo?.id)) primaryWt = wt
            log(`[${groupId}] 工作区 ${repoId}：${wt.path}`)
          }

          if (!primaryWt) throw new Error('主仓库没有建出工作区')

          // 把暂存区里已经攒下的文档搬进工作区：从这一刻起产物跟着工作区走，
          // 合并时直接提交。搬完删暂存区，避免同一份文档出现两个来源。
          // 文档跟着主仓库走（多仓库时也只在一处，避免同一份文档两份来源）
          const scratchDir = st.flow.dataDir
          const wtDocs = join(primaryWt.path, 'docs/requirements', st.flow.reqId)
          // 重跑时 dataDir 已经指向工作区了，src 和 dest 是同一个目录，不用搬
          const needMove = scratchDir && existsSync(scratchDir) && scratchDir !== wtDocs
          if (needMove) {
            try {
              mkdirSync(wtDocs, { recursive: true })
              cpSync(scratchDir, wtDocs, { recursive: true, force: true })
              rmSync(scratchDir, { recursive: true, force: true })
              log(`[${groupId}] 已把暂存区文档搬进工作区（${basename(wtDocs)}）`)
            } catch (err) {
              log(`[${groupId}] 搬暂存区失败（继续用暂存区）：${err.message}`)
            }
          }

          // 就地挂到 st.flow（= runner 的同一个 state 对象）上：
          // workspaces/workDir/dataDir/featureBranch 从这里一路陪跑到合并，
          // 中途不能被 persist 的旧对象覆盖。
          st.flow.workspaces = workspaces
          // workDir 继续指向主仓库：绝大多数需求只动它
          st.flow.workDir = primaryWt.path
          st.flow.dataDir = join(primaryWt.path, 'docs/requirements', st.flow.reqId)
          st.flow.vars = {
            ...st.flow.vars,
            workDir: primaryWt.path,
            workspaces: Object.fromEntries(
              Object.entries(workspaces).map(([id, w]) => [id, w.path]),
            ),
            featureBranch: primaryWt.branch,
            mainBranch: primaryWt.mainBranch,
          }
          store.save(groupId, st)
        }
        // 阶段开始播一句，用户才知道现在在等什么，而不是盯着「已进行 X 分钟」。
        // bridge 自己的动作（merge/wrapup）不播——它们的消息由 bridgeAction 单独发，
        // 这里再补一句「当前合并阶段中」纯属噪音。
        if (!cp.role) return
        await sendPlain(groupId, renderMessage('v2StageStart', { stage: cp.label }, templates), { replyTo }).catch(() => {})
      },
      onCheckpointEnd: async (cp, adv, receipt, verifyReason) => {
        // 阶段级资源无条件先还，再谈「要不要播报」：retry/blocked 回合如果不放
        // 合并锁，下一轮只能干等锁 TTL（5 分钟）过期后被当僵尸抢走——实测
        // merge 失败重试两次就白等了近 5 分钟，而锁其实早该随回合结束归还。
        const held = mergeLocks.get(groupId)
        if (cp.id === 'merge' && held) {
          held.release()
          mergeLocks.delete(groupId)
          log(`[${groupId}] 已释放合并锁`)
        }

        // 设备是阶段级资源：这个阶段跑完就还回去，别让 review 这种
        // 不需要设备的阶段白占着一台模拟器
        if (!cp.forceKeepDevice) {
          const dev = deviceSlots.get(groupId)
          if (dev) {
            // 释放失败不影响流程：租约会在服务重启时自然清空
            await emulator.release(dev.deviceId).catch(() => {})
            deviceSlots.delete(groupId)
            st.flow.vars = { ...st.flow.vars, deviceId: null }
            store.save(groupId, st)
            log(`[${groupId}] 已释放设备 ${dev.deviceId}`)
          }
        }

        // 返工和卡住都不播「完成」——那是假消息，用户会以为过了。
        // 产物交付同理：都返工了，交付半成品是误导。
        if (adv.action === 'retry' || adv.action === 'blocked') return
        // bridge 自己的动作也不播：merge 还没执行就说「合并阶段已完成」是骗人的。
        if (!cp.role) return

        // 回执和产物校验都落日志：出问题时能直接看出是「agent 没写」「写了但没落盘」
        // 还是「写了也落盘了、只是格式不对」，不用再去翻会话文件
        const st0 = receipt?.status ?? '未写回执'
        const summary = String(receipt?.summary ?? '').replace(/\s+/g, ' ').slice(0, 100)
        log(`[${groupId}] 回执：status=${st0}${summary ? ` summary=${summary}` : ''}`)
        // 产物缺失时 flow-runner 会把原因塞进第 4 个参数；有值就说明校验没过。
        // 只进日志不够：merge 的校验失败就是在这种「照常推进」里被静默吞掉的
        // （回执写错工作区、校验不过，群里照样播「合并完成」）。用户必须看到。
        const verifyNote = verifyReason
          ? `⚠️ 产物校验不通过：${String(verifyReason).replace(/\s+/g, ' ').slice(0, 160)}`
          : null
        if (verifyReason) log(`[${groupId}] 产物校验不通过：${String(verifyReason).slice(0, 200)}`)
        if (receipt?.decisions?.length) log(`[${groupId}] 本回合提出 ${receipt.decisions.length} 条待决策`)
        // 开发阶段登记了 debug 包，后面的测试/验收要靠它，存进 vars。
        // agent 忘了写就自己从构建产物里找——比让测试阶段拿着空占位符去猜强。

        if (cp.id === 'dev') {
          const fromReceipt = receipt?.deliverables?.debugPackage
          const found = fromReceipt || findLatestHap(st.projectDir, platformFor(st.flow))
          if (found) {
            st.flow.vars = { ...st.flow.vars, debugPackage: found }
            store.save(groupId, st)
            log(`[${groupId}] debug 包：${found}${fromReceipt ? '' : '（回执没写，从构建产物找到的）'}`)
          }
        }
        // 完成播报带上校验结果：校验没过不是失败（流程继续走），但绝不能
        // 只报「完成」让用户以为产物没问题。
        await sendPlain(
          groupId,
          verifyNote
            ? `${renderMessage('v2StageDone', { stage: cp.label }, templates)}\n${verifyNote}`
            : renderMessage('v2StageDone', { stage: cp.label }, templates),
          { replyTo },
        ).catch(() => {})
        // 验收之后的确认等于授权合并，先说清楚。要不要重跑编译单测由
        // mergeFastForward 判据定（bridge 已在 merge 回合开始前算好），口径别写死
        if (cp.id === 'acceptance') {
          const mergeNote = store.get(groupId)?.flow?.vars?.mergeFastForward === true
            ? 'main 期间没动过，直接合并推送'
            : '会先跑编译和单元测试再推'
          await sendPlain(groupId, `选「通过」后会把 feature 分支合并进主分支（${mergeNote}）。`, { replyTo }).catch(() => {})
        }
        await deliverArtifact({ groupId, repoRoot, projectDir: st.projectDir, cp, reqDir: reqDirOf(adv.state), replyTo })
      },
      onBridgeCheckpoint: async (cp, flow) => {
        await bridgeAction({ groupId, cp, flow, st, replyTo })
      },
      runAgent: async ({ role, checkpoint, prompt, sessionId }) => {
        // 合并是纯确定性搬运（fetch / merge --no-ff / 归档文档 / push / 写回执），
        // 快进场景（main 自分支切出后没动过）不需要模型插手：上两单这一阶段花了
        // 326s、748s，其中工具时间只有 83s，其余全是模型在来回打同样的 git 命令。
        // main 有新提交时三方合并会得到没人测过的新树，那种情况仍派 agent（它会
        // 重跑编译单测），判据由回合开始前的 mergeFastForward 决定。
        if (scriptedMerge && checkpoint.id === 'merge' && st.flow?.vars?.mergeFastForward === true) {
          const mergeWorkDir = st.flow.vars.mergeWorkDir
          const devDir = st.flow.workDir ?? st.flow.vars?.workDir ?? ''
          const reqId = st.flow.reqId
          const mainBranch = st.flow.vars?.mainBranch ?? 'main'
          log(`[${groupId}] 合并走脚本（快进场景，main 无新提交）：${mergeWorkDir}`)
          const r = mergeScriptImpl({
            workDir: mergeWorkDir,
            devDir,
            docsSourceDir: join(devDir, 'docs', 'requirements', reqId),
            reqDir: join(mergeWorkDir, 'docs', 'requirements', reqId),
            repoDir: config.repoDir,
            reqId,
            name: st.flow.name ?? '',
            mainBranch,
            log,
          })
          if (!r.ok) {
            log(`[${groupId}] 脚本化合并失败：${r.error}`)
            return { ok: false, error: r.error }
          }
          log(`[${groupId}] 脚本化合并完成：${r.receipt.summary}`)
          return { ok: true }
        }

        // 每个回合占一个执行槽。这是内存和 token 的真实成本所在：
        // 一个回合就是一个 dsh 子进程，加上可能触发的构建。
        const slot = await turnPool.acquire({
          waitMs: 2 * 60 * 60 * 1000,
          pollMs: 1000,
          tag: checkpoint.id,
        })
        if (!slot) throw new Error('等待执行名额超时（两小时）')
        try {
        const startedAt = Date.now()
        const timeoutMin = Math.round(stageTimeoutMs(checkpoint.id, config) / 60000)
        log(
          `[${groupId}] v2 回合：${checkpoint.id}（${role}，${sessionId ? '续跑' : '新会话'}，超时 ${timeoutMin} 分钟，prompt ${prompt.length} 字）`,
        )
        const r = await runTurn({
          // 记下子进程 pid：bridge 重启时靠它判断「这个回合是真的被打断了，
          // 还是子进程还活着、只是我这个父进程换了一个」
          onChild: (child) => {
            st.flow.activeTurn = { pid: child.pid ?? null, checkpointId: checkpoint.id, startedAt: Date.now() }
            store.save(groupId, st)
          },
          dshBin: config.dshBin,
          profile: config.profile,
          // dev/test/acceptance 要跑 flutter test、gradle 这类构建命令，沙箱的
          // 默认审批模式会挡掉它们，回合只能交出没验证过的代码（补验证要主会话
          // 再花近一个半小时）。headless 的 --approval-policy never 就是给这种
          // 无人值守场景准备的：不弹审批，全部放行。
          approvalPolicy: ['dev', 'test', 'acceptance'].includes(checkpoint.id) ? 'never' : 'ask',
          // dev/test/acceptance 的 agent 要派生 flutter/java/git 子进程做构建验证，
          // 默认沙箱预设连 cmd /c echo 都拒（CreateFile failed 5）。这几类回合
          // 放开沙箱：回合本身无人值守，approval-policy 已是 never。
          permissionMode: ['dev', 'test', 'acceptance'].includes(checkpoint.id)
            ? 'danger-full-access'
            : undefined,
          // cwd 决定子进程的沙箱边界：dev 之后必须切到工作区，
          // 否则产物写在 worktree 里也超出工作区，照样被拒。
          // merge 用专用合并工作区（varsFor 已区分，这里要跟上）——
          // dsh 会按 cwd 归档会话，cwd 错了续跑的会话会因目录不一致被拒。
          projectDir:
            (checkpoint.id === 'merge' ? st.flow.vars?.mergeWorkDir : null) ||
            st.flow.workDir ||
            st.projectDir,
          sessionId,
          prompt,
          // 必须继承 bridge 的完整环境：spawn 的 env 是替换不是合并，
          // 只传 key 的话 Windows 上 dsh.cmd 连 PATH 里的 node 都找不到。
          // dev/test/acceptance 回合还要跑 git/flutter/adb，这些工具常装在
          // 非标准目录且不在系统 PATH 里——配置 toolPaths 补进来（B4 治本）。
          env: withToolPaths({ ...process.env, ...modelEnv }, config.toolPaths),
          // 按阶段取超时：dev/test/acceptance 跑构建和逐条核对，给足时间；
          // 其余阶段默认半小时。配置里没写的阶段退回 default。
          timeoutMs: stageTimeoutMs(checkpoint.id, config),
          signal: aborter.signal,
          onEvent: () => {},
          // 回执先到就提前收工：agent 写完回执（status=done/needs_input/blocked，
          // 都是终态）后进程可能挂住，实测会白等满阶段超时。探针用回执目录
          // 每轮重解析（workDir 随 dev 起变化，同 flow-runner 的取法）。
          receiptProbe: () => {
            const flow = st.flow
            // merge 回合 agent 在合并工作区，回执可能写偏——先兜底搬回正规目录再读
            recoverMergeReceipt(flow, checkpoint.id)
            const dir = reqDirOf(flow)
            const rr = readReceipt(dir, checkpoint.id)
            if (!rr.ok) return null
            return ['done', 'needs_input', 'blocked'].includes(rr.receipt?.status) ? rr.receipt : null
          },
          // 探针盯着哪个目录：runner 用它挂 fs.watch，回执一落地就结算，
          // 不用等 5s 的兜底轮询（实测尾巴能省十几秒一个回合）。
          receiptDir: () => reqDirOf(st.flow),
        })
        // spawn 失败是环境/配置问题，不是 agent 的错。抛出去让 runFromState 报明确错误，
        // 不要走返工——重试三次也不会好，只会把「dsh 找不到」说成「agent 做不出来」。
        if (r.spawnFailed || r.envFailed) {
          // 环境问题一律不返工：重试三次也还是同一个错误，只会把「沙箱没权限」
          // 说成「agent 连续三轮不达标」，把真正的原因埋掉。
          throw new Error(
            `${r.errorSummary ?? '环境错误：dsh 无法正常运行'}（检查 bot.config.json 的 dshBin，或是否在受限环境里启动）`,
          )
        }
        // runTurn 可以来自 runner.js（exitCode/timedOut），也可以是测试注入的简化实现（ok）。
        // 不写死其中一种，否则换个实现就得改这里。
        // settledByReceipt：回合进程是被「回执已合法落盘」的提前收工杀掉的，
        // exitCode 不可作准——工作确实做完了，按成功算。
        const ok = r.ok !== undefined ? r.ok : r.settledByReceipt === true || (r.exitCode === 0 && !r.timedOut)
        const secs = Math.round((Date.now() - startedAt) / 1000)
        const why = r.error ?? r.errorSummary ?? r.turnError ?? '未知'
        if (r.settledByReceipt === true) {
          log(`[${groupId}] 回合提前收工（${secs}s）：${checkpoint.id} 回执已落盘，进程挂住被终止`)
        } else if (!ok) {
          log(`[${groupId}] 回合失败（${secs}s，${timeoutMin} 分钟上限）：${why}`)
        } else {
          log(`[${groupId}] 回合完成（${secs}s）：${checkpoint.id}`)
        }
        st.flow.activeTurn = null
        store.save(groupId, st)
        return { ok, sessionId: r.sessionId, error: ok ? null : why, secs }
        } finally {
          // 不管是正常完成、超时还是抛错，执行槽都要还回去
          slot.release()
        }
      },
    }
  }

  /**
   * 把效果图发出去。图片能直接看，zip 得下载解压——
   * 设计阶段的产出是给人看的，走图片不走文件。
   * transport 会把字节存成产物、回一个 URL 塞进消息里。
   */
  async function sendPreviewImages(groupId, dir, replyTo) {
    const pngs = collectPngs(dir).slice(0, 6)
    if (!pngs.length) return
    await sendPlain(groupId, `设计稿 ${pngs.length} 张：`, { replyTo }).catch(() => {})
    for (const f of pngs) {
      try {
        await tx.sendImage(groupId, { buffer: readFileSync(f), name: basename(f) })
      } catch (err) {
        log(`[${groupId}] 效果图发送失败 ${basename(f)}：${err.message}`)
      }
    }
  }

  /** 阶段产物投到群里。目录类产物（设计稿）暂不打包，见 TODO */
  async function deliverArtifact({ groupId, repoRoot, projectDir, cp, reqDir, replyTo }) {
    // 效果图优先：先让用户看到长什么样，再谈文件
    if (cp.images) {
      await sendPreviewImages(groupId, join(reqDir, cp.images), replyTo)
    }
    if (!cp.deliverable) return
    const file = join(reqDir, cp.deliverable)
    if (!existsSync(file)) {
      // 声明了交付物却没找到文件：不能静默。用户看着「阶段完成」却收不到
      // 任何文件，第一反应是 bot 吞了附件——直接把实情说出去。
      log(`[${groupId}] 交付物缺失：${cp.deliverable}（在 ${reqDir}）`)
      await sendPlain(
        groupId,
        `本阶段声明要交付「${cp.deliverable}」，但工作目录里没有这个文件，无法投递。`,
        { replyTo },
      ).catch(() => {})
      return
    }
    try {
      if (cp.deliverable.endsWith('/')) {
        // 目录产物（设计稿）没法直接发，打包成 zip 再传
        const zip = packDirectory(join(reqDir, cp.deliverable), join(reqDir, `${cp.id}.zip`))
        if (zip) {
          await tx.sendFile(groupId, zip, basename(zip))
          log(`[${groupId}] 已投递打包产物：${basename(zip)}`)
        } else {
          // 打包失败就给路径，至少信息不丢
          await sendPlain(groupId, renderMessage('v2Artifact', { artifacts: cp.deliverable }, templates), { replyTo })
        }
        return
      }
      if (!statSync(file).isFile()) return
      await tx.sendFile(groupId, file, basename(file))
      log(`[${groupId}] 已投递产物：${basename(file)}`)
    } catch (err) {
      log(`[${groupId}] 产物投递失败：${err.message}`)
    }
  }

  /** commit / wrapup 这两个 checkpoint 由 bridge 自己干 */

  /**
   * 猜应用 ID（装包/卸载时用）：鸿蒙读 AppScope/app.json5 的 bundleName，
   * Android 读 build.gradle 的 applicationId。猜不到就留占位符——
   * 猜错比留空更糟，会让 agent 照着错的 ID 去卸载别人的包。
   */
  function guessArtifactId(projectDir) {
  const tries = [
    ['AppScope/app.json5', /"?bundleName"?\s*:\s*"([^"]+)"/],
    ['app/build.gradle', /applicationId\s*=?\s*["']([^"']+)["']/],
    ['app/build.gradle.kts', /applicationId\s*=\s*"([^"]+)"/],
  ]
  for (const [rel, re] of tries) {
    try {
      const m = readFileSync(join(projectDir, rel), 'utf8').match(re)
      if (m?.[1]) return m[1]
    } catch {
      /* 文件不存在就试下一个 */
    }
  }
  return '<应用ID>'
}

/** 把平台适配器渲染成任务包里的一段命令说明 */
function buildPlatformBlock(platform, vars) {
  const lines = ['【平台命令】' + platform.label]
  lines.push(`- 构建：${renderCommand(platform.build, vars)}`)
  lines.push(`- 单测：${renderCommand(platform.test, vars)}`)
  lines.push(`- 装包：${renderCommand(platform.install, vars)}`)
  lines.push(`- 安装包后缀：${platform.artifactExt}`)
  if (platform.sdkEnv) lines.push(`- 需要导出的环境变量：${platform.sdkEnv}`)
  for (const note of platform.notes ?? []) lines.push(`- ${note}`)
  return lines.join('\n')
}

/**
 * 检查本回合有没有动不该动的文件。
 *
 * 版本号（versionCode / versionName）是发布决策。实测有人顺手把它从 1000000
 * 改成 1000002，结果交付说明和 HAP 清单对不上，验收阶段被迫停下来问
 * 「以哪个为准」。这类改动不该由开发回合做，出现了就明确报出来。
 *
 * 只看工作区相对基线的 diff，不修改任何东西——修不修由人决定。
 */
function checkForbiddenChanges(workDir, mainBranch = 'main') {
  const hits = []
  const r = gitRun(workDir, ['diff', `origin/${mainBranch}...HEAD`, '--unified=0'])
  const diff = r.ok ? (r.out ?? '') : ''
  if (!diff) return hits

  if (/^[+-]\s*"?version(Code|Name)"?\s*:/m.test(diff)) {
    const file = diff.match(/^\+\+\+ b\/(.+)$/m)?.[1]
    hits.push(`版本号被改动（${file ?? '未知文件'}）`)
  }
  return hits
}

/**
 * 真正执行合并：把开发工作区的 feature 分支并进主分支。
 *
 * 为什么由 bridge 做：git 的元数据（索引、refs）在各个工作区自己的 .git 里，
 * 但工作区之间的互通要靠 bridge。agent 在沙箱里只能改自己工作区的文件。
 *
 * 步骤：
 *   1. 开发工作区：把 agent 留下的改动提交（用回执里的 commitMessage）
 *   2. 合并工作区：fetch 开发工作区的分支 → merge --no-ff → push
 * 冲突不自动解决：直接中止并报出来，人工介入比瞎猜安全。
 */
async function doMerge({ groupId, flow, st, log, config }) {
  const notes = []
  const devDir = flow.workDir
  const branch = `feature/${flow.reqId}`
  const mainBranch = flow.vars?.mainBranch ?? config.mainBranch ?? 'main'

  if (!devDir || !existsSync(devDir)) return { ok: false, error: `开发工作区不存在：${devDir}` }

  // 合并前拦住不该有的改动：版本号是发布决策，开发回合动了就得有人看一眼
  const forbidden = checkForbiddenChanges(devDir, flow.vars?.mainBranch ?? mainBranch)
  if (forbidden.length) {
    return {
      ok: false,
      error: `发现不该有的改动，已中止合并：${forbidden.join('；')}。确认后回「继续」可以强制合并`,
    }
  }

  // 1. 提交开发工作区的改动
  const dirty = gitRun(devDir, ['status', '--porcelain'])
  if (dirty.out?.trim()) {
    const got = readReceipt(join(devDir, 'docs/requirements', flow.reqId), 'dev')
    const msg =
      got?.receipt?.commitMessage || `feat(${flow.reqId}): ${flow.name ?? '需求实现'}`
    for (const args of [['add', '-A'], ['-c', 'user.name=qq-bot', '-c', 'user.email=bot@local', 'commit', '-q', '-m', msg]]) {
      const r = gitRun(devDir, args)
      if (!r.ok) return { ok: false, error: `提交失败：${r.error}` }
    }
    notes.push('已提交开发工作区的改动')
  }

  // 2. 合并工作区
  const merge = ensureMergeWorktree({
    repoDir: config.repoDir,
    worktreeRoot: config.worktreeRoot,
    mainBranch,
  })
  if (!merge.ok) return { ok: false, error: `准备合并工作区失败：${merge.error}` }

  // 从开发工作区直接 fetch：两个工作区都是独立仓库，靠路径互通
  const pulled = gitRun(merge.path, ['fetch', '--no-tags', devDir, branch])
  if (!pulled.ok) return { ok: false, error: `拉取 ${branch} 失败：${pulled.error}` }

  const merged = gitRun(merge.path, [
    '-c', 'user.name=qq-bot', '-c', 'user.email=bot@local',
    'merge', '--no-ff', '-m', `merge: ${flow.name ?? flow.reqId}`, 'FETCH_HEAD',
  ])
  if (!merged.ok) {
    // 冲突：中止，把冲突文件报出来，让人决定
    const conflicted = gitRun(merge.path, ['diff', '--name-only', '--diff-filter=U']).out?.trim()
    gitRun(merge.path, ['merge', '--abort'])
    return { ok: false, error: `合并冲突（已中止）：${conflicted || merged.error}` }
  }
  notes.push(`已合并 ${branch}`)

  // 3. push
  const pushed = gitRun(merge.path, ['push', '-q', 'origin', mainBranch])
  if (pushed.ok) {
    notes.push('已推送到远端')
  } else {
    // 推不上去不是阻塞：本地合并已完成，下次能推再推
    notes.push(`push 失败（本地已合并）：${pushed.error}`)
  }

  // 4. 让主仓也知道最新 main，下次建工作区才有新起点
  gitRun(config.repoDir, ['fetch', '-q', merge.path, `${mainBranch}:refs/remotes/origin/${mainBranch}`])

  return { ok: true, notes }
}

  async function bridgeAction({ groupId, cp, flow, st, replyTo }) {
    if (cp.id === 'wrapup') {
      const reqDir = reqDirOf(flow)
      // 终检前先兜底：文档可能留在 dev/merge 工作区没随提交进仓库（上轮实测），
      // 能自动找回来就不停下来等人。
      const recovered = backfillFinalArtifacts(reqDir, flow, config)
      if (recovered.length) {
        log(`[${groupId}] 收尾兜底拷回产物：${recovered.join('、')}（来源：开发/合并工作区）`)
      }
      const missing = checkFinalArtifacts(reqDir)
      if (missing.length) {
        log(`[${groupId}] 收尾缺产物（${reqDir}）：${missing.join('、')}`)
        await sendPlain(groupId, `收尾检查发现缺产物：${missing.join('、')}`, { replyTo }).catch(() => {})
        return
      }
      await sendPlain(groupId, renderMessage('v2Done', { name: flow.name ?? flow.reqId }, templates), { replyTo }).catch(() => {})

      // 收尾播报完再回收：文档已随合并提交进仓库，本地副本不再需要。
      // 放在这里而不是合并结束时——wrapup 还要读产物清单做终检，提前删会误报缺产物。
      const cleaned = cleanupAfterMerge({ groupId, flow: st.flow, log, config })
      if (cleaned.notes.length) log(`[${groupId}] 收尾清理：${cleaned.notes.join('；')}`)

      // 需求收尾，把 worktree 名额还回去给排队的需求
      const held = worktreeSlots.get(groupId)
      if (held) {
        held.release()
        worktreeSlots.delete(groupId)
        log(`[${groupId}] 已释放工作区名额`)
      }
    }
  }

  /** 停下时把原因讲清楚：在等什么、卡在哪、还是完成了 */
  async function announceStop({ groupId, replyTo, result, st }) {
    const { flow } = result

    if (result.done || flow.status === 'done') {
      return // wrapup 已经发过完成消息
    }

    if (flow.status === 'waiting_user') {
      // merge 这类 bridge 动作已经在 bridgeAction 里把「回什么才执行」说清楚了，
      // 再补一句「等你回复上面的问题」只会让人以为还要回答别的
      if (flow.waiting?.bridge) return
      const cp = currentCheckpoint(flow)
      // 提问卡片直接进消息流（历史上这里发的是「1. 问题 / A. 选项」纯文本）：
      // 用户得在输入框里手打字母，打错一位 agent 就理解成别的选项；
      // 卡片上点选没有歧义，手机上也不用记「第几个问题对应哪个字母」。
      const ask = askPayloadFor(
        flow.waiting?.decisions ?? [],
        `「${cp?.label ?? '这一步'}」做完了，确认一下`,
        flow.waiting?.decisionsTitle,
      )
      tx.event(groupId, 'ask', ask)
      return
    }

    if (flow.status === 'blocked') {
      const cp = currentCheckpoint(flow)
      // reason 有三条来源：agent 报的 blockers、返工超限、评审闸门不放行。
      // advance 会把它们都收进 waiting.reason，这里优先用它。
      const reason =
        flow.waiting?.reason ||
        flow.waiting?.blockers?.map((b) => b?.reason ?? b).filter(Boolean).join('；')
      await sendPlain(
        groupId,
        renderMessage('v2Blocked', { reason: reason || `「${cp?.label ?? flow.current}」卡住了` }, templates),
        { replyTo },
      ).catch(() => {})
    }
  }

  /**
   * 心跳：长回合里告诉用户还在跑，别让人以为卡死了。
   * 和 v1 的区别：不用算阶段时长（状态机不知道精确起点），只说在哪一步。
   */
  function startHeartbeat({ groupId, st, replyTo }) {
    const minutes = config.heartbeat?.idleMinutes ?? 5
    if (!config.heartbeat?.enabled || minutes <= 0) return null
    return setInterval(() => {
      const flow = st.flow
      if (!flow || flow.status !== 'running') return
      const cp = currentCheckpoint(flow)
      if (!cp) return
      const elapsed = flow.checkpointStartedAt ? Date.now() - flow.checkpointStartedAt : null
      sendPlain(
        groupId,
        renderMessage('heartbeat', { stage: cp.label, duration: elapsed == null ? '一会儿' : formatDuration(elapsed) }, templates),
        {},
      ).catch(() => {})
    }, minutes * 60 * 1000)
  }

  /** 本轮结束后处理排队消息：按顺序重放，每条走一遍入口 */
  function drainQueue({ groupId }) {
    const queued = machine.drainQueue(groupId)
    if (!queued.length) return
    const st = machine.peek(groupId)
    if (!st) return
    const text = queued.join('\n')
    // 不 await：这是下一轮，交给调用栈继续
    handleMessage({ groupId, text, replyTo: null, st, initiator: null, can: null }).catch((e) =>
      log(`[${groupId}] 排队消息处理失败：${e.message}`),
    )
  }

  /** 并发资源快照，面板要显示「几个槽位在用 / 谁在排队」 */
  async function poolStats() {
    // 设备状态问服务要：编排层不维护设备清单，避免和服务里的租约打架
    let devices = { platform: config.platform ?? 'harmony', items: [], available: 0, total: 0 }
    const r = await emulator.list()
    if (r.ok) {
      const items = (r.items ?? []).map((x) => ({
        id: x.name,
        name: x.name,
        running: x.running,
        busy: x.leased === true,
        holder: x.lease?.reqId ?? null,
      }))
      devices = {
        platform: r.platform,
        label: r.label,
        items,
        total: items.length,
        available: items.filter((x) => x.running).length,
        running: items.filter((x) => x.running).length,
        offline: false,
      }
    } else {
      devices.offline = true
      devices.error = r.error
    }

    return {
      worktree: worktreePool.stats(),
      turns: turnPool.stats(),
      pendingWorktrees: worktreePool.position(),
      pendingTurns: turnPool.position(),
      devices,
    }
  }

  return { handleMessage, createRequirement, poolStats }
}

/**
 * 把「用户对上一轮提问的回答」组织成一段有语义的文本。
 *
 * 尝试按位展开成 Q-1 → B 这种形式（读《待提问清单》拿到问题列表），
 * 对不上就原样引用并说明——让 agent 知道这是一串选项字母还是自然语言。
 */
export function buildAnswerBlock(dataDir, rawAnswer, lastDecisions, answers = null) {
  const answer = String(rawAnswer ?? '').trim()
  const cards = (Array.isArray(answers) ? answers : []).filter((a) => a && a.qid)
  if (!answer && !cards.length) return ''

  // 卡片上勾选的选项是结构化的、不会歧义，优先用它。
  // 纯文本那条路径只在用户没点卡片、直接在输入框里说话时才走到。
  if (cards.length) {
    const decisions = (Array.isArray(lastDecisions) ? lastDecisions : []).filter((d) => d?.q)
    const lines = ['【用户对上一轮提问的回答】（在提问卡片上勾选/填写的）']
    if (answer) lines.push(`(另外还打了一句：「${answer}」)`)
    lines.push('')
    for (const a of cards) {
      const n = /^q(\d+)$/.exec(String(a.qid))
      const d = n ? decisions[Number(n[1]) - 1] : null
      const title = d?.q ? String(d.q).trim() : (a.qid === 'confirm' ? '本轮是否通过？' : String(a.qid))
      const labelOf = (id) => {
        const idx = String(id).charCodeAt(0) - 97
        const opt = d?.options?.[idx]
        if (opt?.text) return String(opt.text).trim()
        // 通过/打回卡片没有 lastDecisions 可对位（它不是 agent 提的问题），
        // 只能按约定的 id 还原成中文
        if (String(id) === 'approve') return '通过'
        if (String(id) === 'reject') return '打回'
        return String(id)
      }
      const picked = (a.optionIds ?? []).map(labelOf)
      const input = String(a.input ?? '').trim()
      if (a.qid === 'confirm') {
        if (picked.some((p) => /打回/.test(p))) {
          lines.push(`- 本轮是否通过？ → 打回${input ? `；理由：${input}` : '（没写理由，按用户的意见为主）'}`)
        } else if (picked.length) {
          lines.push('- 本轮是否通过？ → 通过')
        } else if (input) {
          lines.push(`- 本轮是否通过？ → 用户没选，只说了一句：${input}`)
        } else {
          lines.push('- 本轮是否通过？ → 用户没填')
        }
        continue
      }
      if (picked.length && input) lines.push(`- ${title} → ${picked.join('、')}；另外补充：${input}`)
      else if (picked.length) lines.push(`- ${title} → ${picked.join('、')}`)
      else if (input) lines.push(`- ${title} → 用户自己写：${input}`)
      else lines.push(`- ${title} → 用户没选，按推荐值转成采用假设`)
    }
    lines.push('', '勾选的是用户的明确决定，照它做，不要改回你原来推荐的方案。')
    return lines.join('\n')
  }

  // 优先用「上一轮 agent 自己提的问题」：用户回答的就是这些。
  // 没有才退回需求澄清阶段的《待提问清单》——那是 req-prd 回合才适用的旧清单。
  const decisions = Array.isArray(lastDecisions) ? lastDecisions.filter((d) => d?.q) : []
  const questions = decisions.length
    ? decisions.map((d, i) => ({ id: `第 ${i + 1} 条`, title: d.q }))
    : parseQuestionList(join(dataDir, '待提问清单.md'))
  const letters = answer.replace(/[^A-Za-z]/g, '').toUpperCase()

  const lines = ['【用户对上一轮提问的回答】', `用户原话：「${answer}」`, '']

  // 看起来像「一串选项字母」就按位展开；自然语言回答原样保留，不瞎猜。
  // 阈值跟着问题数走：问题少的时候两个字母也该展开，问题多时才需要 >= 3 才不像误触
  const looksLikeLetters =
    /^[A-Za-z]+$/.test(answer.replace(/[\s、,，.]/g, '')) &&
    letters.length >= Math.min(3, questions.length)
  if (questions.length && looksLikeLetters) {
    lines.push(decisions.length ? '按上一轮提问的顺序对应如下：' : '按《待提问清单》的顺序对应如下：')
    for (let i = 0; i < questions.length; i++) {
      const pick = letters[i]
      lines.push(
        `- ${questions[i].id} ${questions[i].title} → ${pick ? `用户选 ${pick}` : '用户未回答，按推荐值转成采用假设'}`,
      )
    }
    lines.push('', '用户明确选了的，以用户的选择为准，不要改回推荐答案。')
  } else if (questions.length) {
    lines.push('这是自然语言回答，请对照《待提问清单》逐条理解；理解不了的写进回执 decisions，不要自己拍板。')
  }

  return lines.join('\n')
}

/** 从《待提问清单》里读出 Q 编号和问题标题 */
export function parseQuestionList(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 3) continue
    const id = cells[1]
    if (!/^Q[-－]?\d+$/i.test(id)) continue
    out.push({ id, title: cells[2] })
  }
  return out
}

/**
 * 合并完成后的资源回收。
 *
 * 为什么删文档目录：合并时已经 rsync 进仓库并提交，远端有了副本，
 * 本地这份再留着只是占磁盘（100 个需求的设计图就是几百 MB）。
 * 万一需要追溯，仓库的 docs/requirements/<reqId>/ 里就是完整的一份。
 */
function cleanupAfterMerge({ groupId, flow, log, config }) {
  const notes = []

  // 1. 所有仓库的工作区 + 本地 feature 分支（多仓库时逐个回收）
  const spaces = flow.workspaces && Object.keys(flow.workspaces).length
    ? Object.entries(flow.workspaces)
    : flow.workDir
      ? [['app', { path: flow.workDir, branch: flow.vars?.featureBranch, repoDir: config.repoDir }]]
      : []

  for (const [repoId, w] of spaces) {
    const r = removeWorktree({
      repoDir: w.repoDir ?? config.repoDir,
      path: w.path ?? flow.workDir,
      branch: w.branch ?? flow.vars?.featureBranch ?? `feature/${flow.reqId}`,
    })
    notes.push(...r.notes)
    if (r.ok) log(`[${groupId}] 已回收工作区 ${repoId}：${w.path ?? flow.workDir}`)
  }

  // 2. 文档目录（仓库里已有归档副本）
  if (flow.dataDir) {
    try {
      rmSync(flow.dataDir, { recursive: true, force: true })
      log(`[${groupId}] 已清理文档目录：${flow.dataDir}`)
    } catch (err) {
      notes.push(`清理文档目录失败：${err.message}`)
    }
  }

  return { notes }
}

/** 从项目目录读 origin 地址；读不到返回空串（由调用方报错） */
function remoteUrlOf(projectDir) {
  const r = gitRun(projectDir, ['remote', 'get-url', 'origin'])
  return r.ok ? r.out : ''
}

/** 主分支：项目目录上没有 git 时退回 main */
function detectRepoMainBranch(projectDir) {
  try {
    return detectMainBranch(projectDir) ?? 'main'
  } catch {
    return 'main'
  }
}

/**
 * 需求产物目录。
 * 新需求用 flow.dataDir（仓库外）；改造前的需求没有这个字段，退回仓库内老路径，
 * 这样历史需求还能继续跑完，不会被一次性切断。
 */
/**
 * 让暂存区被 git 忽略，但**不改项目的 .gitignore**。
 *
 * 用 `.git/info/exclude`：它是本地忽略规则，不进仓库、不影响别人、
 * 也不需要接入方为这套系统做任何改造。第一次用到时才写，写完不再重复。
 */
export function ensureScratchIgnored(projectDir) {
  const exclude = join(projectDir, '.git', 'info', 'exclude')
  try {
    if (existsSync(exclude)) {
      const cur = readFileSync(exclude, 'utf8')
      if (!cur.includes('.qq-bot-scratch')) {
        writeFileSync(exclude, cur.replace(/\n*$/, '\n') + '.qq-bot-scratch/\n')
      }
      return
    }
    // 没有 .git（不是仓库，或者是 worktree 目录）时什么都不做：
    // 暂存区只在主项目里出现，worktree 里不会有
    if (!existsSync(join(projectDir, '.git'))) return
    mkdirSync(dirname(exclude), { recursive: true })
    writeFileSync(exclude, '.qq-bot-scratch/\n')
  } catch {
    /* 加不上就算了：暂存区会出现在 git status 里，不影响流程正确性 */
  }
}

/**
 * 产物目录。分两个阶段两种位置，原因是沙箱和成本：
 *
 * - dev 之前（澄清/设计/技术方案）：`<projectDir>/.qq-bot-scratch/<reqId>/`
 *   dsh 子进程跑在 workspace-write 沙箱里，只能写会话工作区，所以必须落在项目内。
 *   但这几个阶段只写文档，没必要为每个需求 checkout 一份 worktree（项目 268M，
 *   12 个并发就是 2G）。放暂存区、进 .gitignore，主分支和工作区都不会脏。
 *
 * - dev 之后：`<workDir>/docs/requirements/<reqId>/`
 *   进了工作区就该跟着工作区走，合并时直接提交，不需要额外搬运。
 *
 * 整个要保证的是：写的人和校验的人用同一个 reqDirOf。
 */
export function reqDirOf(flow) {
  if (flow?.workDir) return join(flow.workDir, 'docs/requirements', flow.reqId)
  return join(flow?.projectDir ?? '.', '.qq-bot-scratch', flow.reqId)
}

/**
 * 需求标识去重：目标目录里已经有文件就用 <id>-2、<id>-3……
 * 只看「有文件」不看「目录存在」——bridge 建 flow 时会先 mkdir，空目录不算占用。
 */
export function uniqueReqId(projectDir, base) {
  const root = join(projectDir, 'docs/requirements')
  const taken = (id) => {
    try {
      return readdirSync(join(root, id)).length > 0
    } catch {
      return false
    }
  }
  if (!taken(base)) return base
  let n = 2
  while (taken(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/**
 * merge 回执兜底：agent 跑在合并工作区，回执可能写在工作区根或合并工作区的
 * 需求目录（旧版 prompt 没把 reqDir 指过去，实测踩过两次）。正规目录读不到时
 * 去这几个已知位置找，找到就搬回正规目录——搬完后调用方重新读就是权威路径。
 * 返回 true 表示已搬回（或本来就在）。
 */
export function recoverMergeReceipt(flow, checkpointId) {
  if (checkpointId !== 'merge') return false
  const canonicalDir = reqDirOf(flow)
  const canonical = join(canonicalDir, receiptFile(checkpointId))
  if (existsSync(canonical)) return true

  const mergeWork = flow?.vars?.mergeWorkDir
  if (!mergeWork) return false
  // 搜索顺序：合并工作区需求目录 → 工作区根（agent 最容易写错的地方）
  const candidates = [
    join(mergeWork, 'docs/requirements', flow.reqId),
    mergeWork,
  ]
  for (const dir of candidates) {
    const from = join(dir, receiptFile(checkpointId))
    if (!existsSync(from) || from === canonical) continue
    try {
      mkdirSync(canonicalDir, { recursive: true })
      copyFileSync(from, canonical)
      return true
    } catch {
      /* 拷不动就算了，让上层报「没写回执」 */
    }
  }
  return false
}

/** 收尾终检：checkpoint 声明的产物是否都在盘上 */
function checkFinalArtifacts(reqDir) {
  const must = ['需求卡片.md', 'PRD.md', '技术方案.md', '测试报告.md', '验收文档.md']
  return must.filter((f) => !existsSync(join(reqDir, f)))
}

/**
 * 收尾缺产物的兜底：从已知的历史存放点把文档拷回收尾目录再查一遍。
 * 上轮实测：文档在 dev 工作区里没随合并提交进仓库、回收执路径又写了别的
 * 工作区——三处各有几份，终检总会漏。与其停下来等人补拷，不如按固定
 * 搜索顺序自动找回来：dev 工作区（agent 干活的地方，最全）→ 合并工作区
 * （归档副本）→ 工作区约定路径（<worktreeRoot>/<reqId>，不看 flow 记没记）。
 * 返回补拷回来的文件名列表（空数组 = 没找回任何东西）。
 * （export 只为测试直测兜底顺序。）
 */
export function backfillFinalArtifacts(reqDir, flow, config) {
  const missing = checkFinalArtifacts(reqDir)
  if (!missing.length) return []

  const devDir = flow?.workDir ? join(flow.workDir, 'docs/requirements', flow.reqId) : null
  const mergeDir = flow?.vars?.mergeWorkDir
    ? join(flow.vars.mergeWorkDir, 'docs/requirements', flow.reqId)
    : null
  // 约定路径兜底：工作区目录 = <worktreeRoot>/<reqId>，不看 flow 里记没记。
  // 上轮实测 wrapup 时 flow.workDir 已经丢了（回执没写的 merge 回合没拦住
  // 状态推进），但工作区本体还健在——按约定路径仍能把文档找回来。
  const wtRoot = config?.primaryRepo?.worktreeRoot
  const wtDir = wtRoot && flow?.reqId ? join(wtRoot, flow.reqId, 'docs/requirements', flow.reqId) : null
  const sources = [devDir, mergeDir, wtDir].filter((d) => d && d !== reqDir)

  const recovered = []
  for (const f of missing) {
    for (const src of sources) {
      const from = join(src, f)
      if (!existsSync(from)) continue
      try {
        mkdirSync(reqDir, { recursive: true }) // 收尾目录可能还没建（store 里没有 dataDir 时）
        copyFileSync(from, join(reqDir, f))
        recovered.push(f)
        break
      } catch {
        /* 拷不动就试下一个来源 */
      }
    }
  }
  return recovered
}

/**
 * 打目录成 zip。用系统 zip 命令，不引第三方库。
 * 在父目录里打包，避免把绝对路径写进 zip 内部。
 */
function packDirectory(dir, outFile) {
  try {
    // Windows 没有 zip 命令，但 Win10 1803+ 自带 bsdtar；
    // -a 按扩展名自动选格式，产出的就是标准 zip，不用引第三方库。
    const [bin, args] =
      process.platform === 'win32'
        ? ['tar', ['-a', '-c', '-f', outFile, basename(dir)]]
        : ['zip', ['-rq', outFile, basename(dir)]]
    execFileSync(bin, args, { cwd: dirname(dir), stdio: 'ignore' })
    return existsSync(outFile) ? outFile : null
  } catch {
    return null
  }
}

/** 递归找出目录下所有 png（设计稿按页面分子目录，只找一层会漏） */
function collectPngs(dir) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && /\\.png$/i.test(e.name)) out.push(full)
    }
  }
  walk(dir)
  // before-after 放最前面：一眼能看出改了什么
  return out.sort((a, b) => {
    const ab = /before-after/i.test(a) ? 0 : 1
    const bb = /before-after/i.test(b) ? 0 : 1
    return ab - bb || a.localeCompare(b)
  })
}

/** 跑 git 命令，失败返回空串——git 不可用不该让流程崩 */
function safeGit(cwd, args) {
  try {
    // 不要拼成 shell 字符串：Windows 上走 cmd.exe，路径里的空格和中文会被拆开。
    // execFileSync 不经过 shell，参数原样传给 git。
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** 项目顶层目录，给 agent 一个结构感，不递归（避免几万行塞进 prompt） */
function listTop(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name + '/')
      .join('、')
  } catch {
    return ''
  }
}

/**
 * 从构建产物里找最新的应用包（排除测试包）。
 * 开发 agent 可能忘了在回执里登记，但包一般已经构建出来了。
 */
function findLatestHap(projectDir, platform) {
  let newest = null
  // 安装包后缀跟平台走：鸿蒙 .hap、Android .apk、iOS .app
  const extRe = new RegExp(`${platform.artifactExt.replace('.', '\\.')}$`, 'i')
  for (const root of [join(projectDir, 'entry/build'), join(projectDir, 'build')]) {
    for (const f of collectFiles(root, extRe)) {
      if (/ohosTest/i.test(f)) continue
      try {
        const m = statSync(f).mtimeMs
        if (!newest || m > newest.m) newest = { f, m }
      } catch {
        /* ignore */
      }
    }
  }
  return newest?.f ?? ''
}

/** 递归收集匹配的文件 */
function collectFiles(dir, re) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && re.test(e.name)) out.push(full)
    }
  }
  walk(dir)
  return out
}

/** 某个阶段的回合超时（毫秒）。配置按阶段给，没配就用 default */
export function stageTimeoutMs(checkpointId, cfg) {
  const map = cfg?.stageTimeouts ?? {}
  const m = Number(map[checkpointId] ?? map.default ?? 30)
  return Math.min(180, Math.max(1, m)) * 60 * 1000
}
