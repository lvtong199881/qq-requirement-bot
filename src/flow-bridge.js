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
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { renderMessage } from './ui/messages.js'
import { formatDuration } from './ui/format.js'
import { parseCommand } from './commands.js'
import { initialState, resumeFromUser, currentCheckpoint, needsAgent, getCheckpoint } from './flow/flow.js'
import { runFlow } from './flow/flow-runner.js'
import { readReceipt } from './flow/orchestrator.js'
import { writeBoard } from './flow/board.js'
import { gitRun, detectMainBranch } from './infra/git.js'
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

/** 把回执里的 decisions 渲染成给人看的列表（替代旧的 [[ASK]] JSON 渲染） */
export function formatDecisions(decisions) {
  return (decisions ?? [])
    .map((d, i) => {
      const opts = (d.options ?? []).map((o, j) => {
        const key = String.fromCharCode(65 + j)
        return `   ${key}. ${o.text}${o.recommended ? '（推荐）' : ''}`
      })
      return [`${i + 1}. ${d.q}`, ...opts].join('\n')
    })
    .join('\n')
}

/**
 * @param {object} deps
 *   config, store, machine, log, sendPlain, runTurn, bot, modelEnv, repoRoot
 */
/** 群 → 已持有的合并锁。回合结束（或失败）时释放 */
const mergeLocks = new Map()
/** 群 → 已持有的 worktree 槽。合并收尾时释放 */
const worktreeSlots = new Map()
/** 群 → 已占用的设备。阶段结束释放 */
const deviceSlots = new Map()

export function createFlowBridge(deps) {
  const { config, store, machine, log, sendPlain, runTurn, bot, modelEnv, repoRoot, gitDiff } = deps

  // 两层并发闸门，都落在磁盘上（进程崩了占位会按 pid 自动清理）：
  //   worktree 池 —— 同时处于开发期的需求数，决定磁盘占用
  //   执行槽     —— 同时跑的回合数，决定内存和 token 消耗
  const poolsRoot = join(config.repoDir, '..', 'pools')
  const worktreePool = new SlotPool(join(poolsRoot, 'worktree'), config.limits?.maxWorktrees ?? 12)
  const turnPool = new SlotPool(join(poolsRoot, 'turn'), config.limits?.maxConcurrentTurns ?? 2)
  // 设备归模拟器服务管：编排层只申请/释放，不碰具体设备也不读平台配置。
  // 允许注入，测试就不必真的起一个服务。
  const emulator = deps.emulator ?? createEmulatorClient(config)
  // 平台跟着主仓库走：主仓库是鸿蒙就按鸿蒙的构建和装包命令来
  const platform = platformOf(config.primaryRepo)
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
  async function handleMessage({ groupId, text, replyTo, st, initiator, can }) {
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

    // 上一条消息因为「没说清是哪个项目」被拦下了：这条是选择
    if (st.pendingRepoChoice) {
      const pending = st.pendingRepoChoice
      const repos = (config.repos ?? []).filter((r) => pending.candidates.includes(r.id))
      const raw = String(text ?? '').trim()
      const byIndex = /^\d+$/.test(raw) ? repos[Number(raw) - 1] : null
      const byName = repos.find((r) => r.name && r.name.toLowerCase() === raw.toLowerCase())
      const chosen = byIndex ?? byName

      if (!chosen) {
        await sendPlain(
          groupId,
          `没认出「${raw}」。回复序号或项目名：\n` +
            repos.map((r, i) => `${i + 1}. ${r.name}`).join('\n'),
          { replyTo },
        )
        return
      }
      delete st.pendingRepoChoice
      store.save(groupId, st)
      return startNewRequirement({ groupId, text: pending.text, replyTo, st, initiator })
    }

    const flow = st.flow ?? null

    // 没绑需求：这条就是需求描述
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
      if (!text.trim()) {
        await sendPlain(groupId, '直接说需求就行，比如：首页加个欢迎弹窗。', { replyTo })
        return
      }
      // 发起需求只允许群主（和系统管理员）。群管理员能确认但不能开新需求——
      // 这是团队协作里的职责划分，不是技术限制。
      if (can) {
        const perm = await can('startRequirement', initiator?.userId)
        if (!perm.ok) {
          await sendPlain(
            groupId,
            `发起需求需要群主权限（当前角色：${perm.role ?? '未知'}）。已有需求可以直接回复「通过」「打回」参与。`,
            { replyTo },
          )
          return
        }
      }
      return startNewRequirement({ groupId, text, replyTo, st, initiator })
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
        `上次回合异常中断，停在「${cp?.label ?? flow.current}」。回复「继续」重跑这一步。`,
        { replyTo },
      )
      return
    }

    // 等用户回答/拍板
    if (flow.status === 'waiting_user') {
      // commit 的等待是「要不要提交」，不是对 agent 提问的回答
      return answerWaiting({ groupId, text, replyTo, st, initiator })
    }

    // 卡住了：用户给一句话就接着试（重置本轮计数，但不重置历史轮次）
    if (flow.status === 'blocked') {
      return retryBlocked({ groupId, text, replyTo, st })
    }
  }

  /**
   * 这条需求该落在哪个仓库？
   *
   * 不设「默认项目」——改哪个 app 由需求内容决定。按项目名匹配需求文本，
   * 匹配不到、又配了多个项目时问用户，绝不猜：猜错了整条需求会跑在错的仓库上，
   * 等发现时已经烧掉几十分钟。
   *
   * @returns {{ok:true, repo:object} | {ok:false, reason:string, candidates:object[]}}
   */
  function pickRepoFor(text) {
    const repos = config.repos ?? []
    if (!repos.length) return { ok: false, reason: '没有配置任何项目', candidates: [] }
    if (repos.length === 1) return { ok: true, repo: repos[0] }

    const lower = String(text ?? '').toLowerCase()
    // 项目名出现在需求里就算命中；多个命中取名字最长的（更具体）
    const hits = repos
      .filter((r) => r.name && lower.includes(String(r.name).toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)
    if (hits.length) return { ok: true, repo: hits[0], matchedBy: 'name' }

    return { ok: false, reason: '需求里没提是哪个项目', candidates: repos }
  }

  async function startNewRequirement({ groupId, text, replyTo, st, initiator }) {
    // 随机 8 位标识，和名称无关——两个人提相似需求也不会撞目录
    const reqId = makeReqId()

    const picked = pickRepoFor(text)
    if (!picked.ok) {
      // 多个项目又没提到具体哪个：给用户选，别自己猜
      const list = picked.candidates
        .map((r, i) => `${i + 1}. ${r.name}（${platformOf(r).label}）`)
        .join('\n')
      await sendPlain(
        groupId,
        `${picked.reason}。这条需求属于哪个项目？回复序号或项目名：\n${list}`,
        { replyTo },
      )
      // 记下来：下一条消息用来选项目，不当成新需求
      st.pendingRepoChoice = {
        reqId,
        text,
        candidates: picked.candidates.map((r) => r.id),
        at: Date.now(),
      }
      store.save(groupId, st)
      return
    }
    st.projectDir = picked.repo.path
    // 暂存区建在项目内：子进程沙箱只能写会话工作区。
    // 用本地 exclude 忽略它，接入方不需要改 .gitignore。
    ensureScratchIgnored(st.projectDir)
    const dataDir = join(st.projectDir, '.qq-bot-scratch', reqId)
    try {
      mkdirSync(dataDir, { recursive: true })
    } catch (err) {
      await sendPlain(groupId, `创建需求目录失败：${err.message}`, { replyTo })
      return
    }

    const flow = {
      ...initialState({
        reqId,
        name: makeReqName(text),
        projectDir: st.projectDir,
        // 产物落在项目内的 docs/requirements/<reqId>/：dsh 子进程的沙箱限制在工作区，
        // 写到外面会被拒绝（见 reqDirOf 的注释）。
        dataDir,
        repoDir: config.repoDir,
      }),
      requestText: text,
      vars: {},
      roleSessions: {},
    }

    st.flow = flow
    st.reqId = reqId
    if (initiator) st.initiator = initiator
    store.save(groupId, st)

    await sendPlain(
      groupId,
      renderMessage('v2Kickoff', { name: flow.name ?? flow.reqId }, templates),
      { replyTo },
    )
    await runFromState({ groupId, st, replyTo })
  }

  async function answerWaiting({ groupId, text, replyTo, st, initiator }) {
    const flow = st.flow
    // 用户这句话既是「对等待事项的回答」，也可能是修改意见；先原样存进 vars，
    // 由该阶段的 agent 自己判断怎么用（bridge 不做语义猜测）。
    // 上一轮 agent 提的问题也要存下来——否则「AA」这种回答会被拿去和
    // 《待提问清单》（需求澄清阶段的旧清单）比对，永远对不上。
    const prevDecisions = flow.waiting?.decisions ?? []
    const answered = {
      ...resumeFromUser(flow),
      vars: { ...flow.vars, userAnswer: text, lastDecisions: prevDecisions },
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
    return {
      skillsDir,
      reqDir,
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
        reqDir: reqDirOf(flow) + '/',
        userRequest: flow.requestText ?? '',
        userAnswer: flow.vars?.userAnswer ?? '',
        // 用户回答单独成段，并且尽量和问题编号对齐——直接塞进「输入文件清单」里，
        // agent 会把它当成一个文件名或占位符去猜（实测：它数了字母个数，怀疑是乱码）。
        answerBlock: buildAnswerBlock(reqDirOf(flow), flow.vars?.userAnswer, flow.vars?.lastDecisions),
        // 代码工作区：dev 之后才有；之前的阶段不传，避免 agent 去找一个不存在的目录
        // merge 阶段在专用工作区里操作；其他阶段用需求自己的工作区
        workDir: (flow.current === 'merge' ? flow.vars?.mergeWorkDir : flow.workDir) ?? flow.workDir ?? '',
        deviceId: flow.vars?.deviceId ?? '',
        platform: platform.id,
        // 平台命令块：构建/测试/装包怎么跑，由适配器决定
        platformBlock: buildPlatformBlock(platform, {
          deviceId: flow.vars?.deviceId ?? '<设备ID>',
          artifactId: flow.vars?.artifactId ?? guessArtifactId(st.projectDir),
        }),
        dataDir: reqDirOf(flow),
        // 目录树给对地方：dev 之后看工作区，之前看主仓库
        projectTree: listTop(flow.workDir ?? st.projectDir),
        changedFiles: '',
        diff: '',
        debugPackage: flow.vars?.debugPackage ?? '',
        screenshots: 'docs/ui-screenshots/',
        testAccount: '',
        envHints: config.envHints ?? '',
        mergeInfo:
          `feature 分支：${flow.vars?.featureBranch ?? `feature/${flow.reqId}`}\n` +
          `主分支：${flow.vars?.mainBranch ?? (() => { try { return detectMainBranch(st.projectDir) } catch { return 'main' } })()}`,
      }),
      onCheckpointStart: async (cp) => {
        // 记下阶段开始时刻，心跳要报「这一阶段已经跑了多久」。
        // 放在 bridge 而不是 flow.js：状态机是纯函数，不碰时间。
        st.flow = { ...st.flow, checkpointStartedAt: Date.now() }
        store.save(groupId, st)
        // 开发阶段建一个独立工作区（worktree）。这一步是团队化的核心：
        // 所有需求共用主工作区时，两个需求的 dev 会互相 checkout 打断对方，
        // 而且没有任何报错——代码就写到了错误的分支上。worktree 让每个需求独占一个目录。
        // 需要设备（模拟器/真机）的阶段先抢一台。设备是独占资源：
        // 两个回合同时往同一台设备装包，会出现「包被覆盖」「测试跑到别人的版本上」
        // 这类极难排查的问题，而且完全没有报错。
        if (cp.needsDevice && !deviceSlots.has(groupId)) {
          // 带平台：安卓需求不该拿到鸿蒙模拟器
          const granted = await emulator.lease({
            reqId: st.flow.reqId,
            stage: cp.id,
            platform: platform.id,
          })
          if (!granted.ok) {
            throw new Error(
              `「${cp.label}」需要设备，但模拟器服务没给：${granted.error}` +
                (granted.offline ? '（启动 node src/emulator-service.js）' : '（启动一台模拟器后回复「继续」）'),
            )
          }
          deviceSlots.set(groupId, { deviceId: granted.deviceId })
          st.flow = { ...st.flow, vars: { ...st.flow.vars, deviceId: granted.deviceId } }
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

          st.flow = {
            ...st.flow,
            vars: { ...st.flow.vars, mergeWorkDir: mw.path, mergeLockFile: lockFile },
          }
          store.save(groupId, st)
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
          const repoIds = st.flow.repos?.length ? st.flow.repos : [config.primaryRepo.id]
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
              remoteUrl: repoCfg.remoteUrl || config.remoteUrl || remoteUrlOf(repoCfg.path),
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
            if (repoCfg.primary) primaryWt = wt
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

          st.flow = {
            ...st.flow,
            workspaces,
            // workDir 继续指向主仓库：绝大多数需求只动它
            workDir: primaryWt.path,
            dataDir: join(primaryWt.path, 'docs/requirements', st.flow.reqId),
            vars: {
              ...st.flow.vars,
              workDir: primaryWt.path,
              workspaces: Object.fromEntries(
                Object.entries(workspaces).map(([id, w]) => [id, w.path]),
              ),
              featureBranch: primaryWt.branch,
              mainBranch: primaryWt.mainBranch,
            },
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
        // 返工和卡住都不播「完成」——那是假消息，用户会以为过了。
        // bridge 自己的动作也不播：merge 还没执行就说「合并阶段已完成」是骗人的。
        if (adv.action === 'retry' || adv.action === 'blocked') return
        if (!cp.role) return

        // 回执和产物校验都落日志：出问题时能直接看出是「agent 没写」「写了但没落盘」
        // 还是「写了也落盘了、只是格式不对」，不用再去翻会话文件
        const st0 = receipt?.status ?? '未写回执'
        const summary = String(receipt?.summary ?? '').replace(/\s+/g, ' ').slice(0, 100)
        log(`[${groupId}] 回执：status=${st0}${summary ? ` summary=${summary}` : ''}`)
        // 产物缺失时 flow-runner 会把原因塞进第 4 个参数；有值就说明校验没过
        if (verifyReason) log(`[${groupId}] 产物校验不通过：${String(verifyReason).slice(0, 200)}`)
        if (receipt?.decisions?.length) log(`[${groupId}] 本回合提出 ${receipt.decisions.length} 条待决策`)
        // 开发阶段登记了 debug 包，后面的测试/验收要靠它，存进 vars。
        // agent 忘了写就自己从构建产物里找——比让测试阶段拿着空占位符去猜强。

        if (cp.id === 'dev') {
          const fromReceipt = receipt?.deliverables?.debugPackage
          const found = fromReceipt || findLatestHap(st.projectDir, platform)
          if (found) {
            st.flow = { ...st.flow, vars: { ...st.flow.vars, debugPackage: found } }
            store.save(groupId, st)
            log(`[${groupId}] debug 包：${found}${fromReceipt ? '' : '（回执没写，从构建产物找到的）'}`)
          }
        }
        await sendPlain(groupId, renderMessage('v2StageDone', { stage: cp.label }, templates), { replyTo }).catch(() => {})
        // 验收之后的确认等于授权合并，先说清楚
        if (cp.id === 'acceptance') {
          await sendPlain(groupId, '回复「通过」后会把 feature 分支合并进主分支（合并会自动跑编译和单元测试）。', { replyTo }).catch(() => {})
        }
        await deliverArtifact({ groupId, repoRoot, projectDir: st.projectDir, cp, reqDir, replyTo })

        // 设备是阶段级资源：这个阶段跑完就还回去，别让 review 这种
        // 不需要设备的阶段白占着一台模拟器
        if (!cp.forceKeepDevice) {
          const dev = deviceSlots.get(groupId)
          if (dev) {
            // 释放失败不影响流程：租约会在服务重启时自然清空
            await emulator.release(dev.deviceId).catch(() => {})
            deviceSlots.delete(groupId)
            st.flow = { ...st.flow, vars: { ...st.flow.vars, deviceId: null } }
            store.save(groupId, st)
            log(`[${groupId}] 已释放设备 ${dev.deviceId}`)
          }
        }

        // 合并回合结束就放锁，别占着让下一个需求干等
        const held = mergeLocks.get(groupId)
        if (cp.id === 'merge' && held) {
          held.release()
          mergeLocks.delete(groupId)
          log(`[${groupId}] 已释放合并锁`)
        }
      },
      onBridgeCheckpoint: async (cp, flow) => {
        await bridgeAction({ groupId, cp, flow, st, replyTo })
      },
      runAgent: async ({ role, checkpoint, prompt, sessionId }) => {
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
            st.flow = {
              ...st.flow,
              activeTurn: { pid: child.pid ?? null, checkpointId: checkpoint.id, startedAt: Date.now() },
            }
            store.save(groupId, st)
          },
          dshBin: config.dshBin,
          profile: config.profile,
          // cwd 决定子进程的沙箱边界：dev 之后必须切到工作区，
          // 否则产物写在 worktree 里也超出工作区，照样被拒。
          projectDir: st.flow.workDir || st.projectDir,
          sessionId,
          prompt,
          // 必须继承 bridge 的完整环境：spawn 的 env 是替换不是合并，
          // 只传 key 的话 Windows 上 dsh.cmd 连 PATH 里的 node 都找不到。
          env: { ...process.env, ...modelEnv },
          // 按阶段取超时：dev/test/acceptance 跑构建和逐条核对，给足时间；
          // 其余阶段默认半小时。配置里没写的阶段退回 default。
          timeoutMs: stageTimeoutMs(checkpoint.id, config),
          signal: aborter.signal,
          onEvent: () => {},
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
        const ok = r.ok !== undefined ? r.ok : r.exitCode === 0 && !r.timedOut
        const secs = Math.round((Date.now() - startedAt) / 1000)
        const why = r.error ?? r.errorSummary ?? r.turnError ?? '未知'
        if (!ok) {
          log(`[${groupId}] 回合失败（${secs}s，${timeoutMin} 分钟上限）：${why}`)
        } else {
          log(`[${groupId}] 回合完成（${secs}s）：${checkpoint.id}`)
        }
        st.flow = { ...st.flow, activeTurn: null }
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
   * 把效果图直接发到群里。QQ 里图片能直接看，zip 得下载解压——
   * 设计阶段的产出是给人看的，走图片不走文件。
   * NapCat 可能跑在 Docker 里看不到宿主机路径，所以用 base64 内联。
   */
  async function sendPreviewImages(groupId, dir, replyTo) {
    const pngs = collectPngs(dir).slice(0, 6)
    if (!pngs.length) return
    await sendPlain(groupId, `设计稿 ${pngs.length} 张：`, { replyTo }).catch(() => {})
    for (const f of pngs) {
      try {
        const buf = readFileSync(f)
        await bot.sendGroupMsg(groupId, [
          { type: 'image', data: { file: `base64://${buf.toString('base64')}` } },
        ])
        await new Promise((r) => setTimeout(r, 600)) // 连发太快容易被风控
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
    if (!existsSync(file)) return
    try {
      if (cp.deliverable.endsWith('/')) {
        // 目录产物（设计稿）没法直接发，打包成 zip 再传
        const zip = packDirectory(join(reqDir, cp.deliverable), join(reqDir, `${cp.id}.zip`))
        if (zip) {
          await bot.uploadGroupFile(groupId, zip, basename(zip))
          log(`[${groupId}] 已投递打包产物：${basename(zip)}`)
        } else {
          // 打包失败就给路径，至少信息不丢
          await sendPlain(groupId, renderMessage('v2Artifact', { artifacts: cp.deliverable }, templates), { replyTo })
        }
        return
      }
      if (!statSync(file).isFile()) return
      await bot.uploadGroupFile(groupId, file, basename(file))
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
      const decisions = formatDecisions(flow.waiting?.decisions)
      if (decisions) {
        await sendPlain(groupId, renderMessage('v2Waiting', { content: decisions }, templates), { replyTo }).catch(() => {})
      } else {
        // 没有决策项 = 阶段正常完成，人工模式下等一句「通过」。
        // 之前这里复用了「等你回复上面的问题」，可上面根本没提问，用户只会困惑。
        const nextLabel = getCheckpoint(flow.waiting?.advanceTo)?.label ?? '下一步'
        await sendPlain(
          groupId,
          renderMessage('v2Confirm', { stage: currentCheckpoint(flow)?.label ?? '', next: nextLabel }, templates),
          { replyTo },
        ).catch(() => {})
      }
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

  return { handleMessage, poolStats }
}

/**
 * 把「用户对上一轮提问的回答」组织成一段有语义的文本。
 *
 * 尝试按位展开成 Q-1 → B 这种形式（读《待提问清单》拿到问题列表），
 * 对不上就原样引用并说明——让 agent 知道这是一串选项字母还是自然语言。
 */
export function buildAnswerBlock(dataDir, rawAnswer, lastDecisions) {
  const answer = String(rawAnswer ?? '').trim()
  if (!answer) return ''

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

/** 收尾终检：checkpoint 声明的产物是否都在盘上 */
function checkFinalArtifacts(reqDir) {
  const must = ['需求卡片.md', 'PRD.md', '技术方案.md', '测试报告.md', '验收文档.md']
  return must.filter((f) => !existsSync(join(reqDir, f)))
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
