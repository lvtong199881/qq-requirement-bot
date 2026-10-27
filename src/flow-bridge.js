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
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { renderMessage } from './ui/messages.js'
import { formatDuration } from './ui/format.js'
import { parseCommand } from './commands.js'
import { initialState, resumeFromUser, currentCheckpoint, needsAgent, getCheckpoint } from './flow/flow.js'
import { runFlow } from './flow/flow-runner.js'
import { writeBoard } from './flow/board.js'
import { gitRun, detectMainBranch, ensureFeatureBranch } from './infra/git.js'

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
export function createFlowBridge(deps) {
  const { config, store, machine, log, sendPlain, runTurn, bot, modelEnv, repoRoot, gitDiff } = deps
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
  async function handleMessage({ groupId, text, replyTo, st, initiator }) {
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
      return answerWaiting({ groupId, text, replyTo, st })
    }

    // 卡住了：用户给一句话就接着试（重置本轮计数，但不重置历史轮次）
    if (flow.status === 'blocked') {
      return retryBlocked({ groupId, text, replyTo, st })
    }
  }

  async function startNewRequirement({ groupId, text, replyTo, st, initiator }) {
    // 从文本提取的 id 可能撞车（两个群提相似需求，比如都提到同一个模块名）。
    // 撞了就加后缀——否则新需求会写进别人的目录，把已有产物覆盖掉。
    const reqId = uniqueReqId(st.projectDir, makeReqId())
    const flow = {
      ...initialState({ reqId, projectDir: st.projectDir }),
      name: makeReqName(text),
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

  async function answerWaiting({ groupId, text, replyTo, st }) {
    const flow = st.flow
    // 用户这句话既是「对等待事项的回答」，也可能是修改意见；先原样存进 vars，
    // 由该阶段的 agent 自己判断怎么用（bridge 不做语义猜测）。
    // 上一轮 agent 提的问题也要存下来——否则「AA」这种回答会被拿去和
    // 《待提问清单》（需求澄清阶段的旧清单）比对，永远对不上。
    const prevDecisions = flow.waiting?.decisions ?? []
    const answered = {
      ...resumeFromUser(flow),
      vars: { ...flow.vars, userAnswer: text, lastDecisions: prevDecisions },
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
    const reqDir = join(st.projectDir, 'docs/requirements', flow.reqId)
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
      gitDiff: () => readGitDiff(st.projectDir),
      // 群配置是手动批准时，每个阶段的产物都停下来等人点头
      requireApproval: config.approval === 'manual',
      persist: (flow) => {
        st.flow = flow
        store.save(groupId, st)
        // 编排记录跟着状态走一次：面板和人都看这份，不需要谁去解析它
        writeBoard(join(st.projectDir, 'docs/requirements', flow.reqId), flow)
      },
      varsFor: (cp, flow) => ({
        reqDir: join(st.projectDir, 'docs/requirements', flow.reqId) + '/',
        userRequest: flow.requestText ?? '',
        userAnswer: flow.vars?.userAnswer ?? '',
        // 用户回答单独成段，并且尽量和问题编号对齐——直接塞进「输入文件清单」里，
        // agent 会把它当成一个文件名或占位符去猜（实测：它数了字母个数，怀疑是乱码）。
        answerBlock: buildAnswerBlock(
          st.projectDir,
          flow.reqId,
          flow.vars?.userAnswer,
          flow.vars?.lastDecisions,
        ),
        projectTree: listTop(st.projectDir),
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
        // 开发阶段前切到 feature/<reqId>：代码改动和提交都落在 feature 上，
        // 主分支在合并阶段之前保持干净。切不过去就直接报错，不让 agent 在主分支上写代码。
        if (cp.id === 'dev') {
          const isGit = gitRun(st.projectDir, ['rev-parse', '--git-dir']).ok
          if (!isGit) {
            // 不是 git 仓库：没有分支可切，正常继续（有些项目就是不用 git）
            log(`[${groupId}] 不是 git 仓库，跳过 feature 分支`)
          } else {
          const main = detectMainBranch(st.projectDir)
          const b = ensureFeatureBranch(st.projectDir, st.flow.reqId)
          if (!b.ok) throw new Error(`切换 feature 分支失败：${b.error}`)
          log(`[${groupId}] 分支：${b.branch}${b.created ? `（从 ${b.from ?? main} 新建）` : '（已存在，切过去）'}`)
          st.flow = {
            ...st.flow,
            vars: { ...st.flow.vars, featureBranch: b.branch, mainBranch: b.from ?? main },
          }
          store.save(groupId, st)
          }
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
          const found = fromReceipt || findLatestHap(st.projectDir)
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
      },
      onBridgeCheckpoint: async (cp, flow) => {
        await bridgeAction({ groupId, cp, flow, st, replyTo })
      },
      runAgent: async ({ role, checkpoint, prompt, sessionId }) => {
        const startedAt = Date.now()
        const timeoutMin = Math.round(stageTimeoutMs(checkpoint.id, config) / 60000)
        log(
          `[${groupId}] v2 回合：${checkpoint.id}（${role}，${sessionId ? '续跑' : '新会话'}，超时 ${timeoutMin} 分钟，prompt ${prompt.length} 字）`,
        )
        const r = await runTurn({
          dshBin: config.dshBin,
          profile: config.profile,
          projectDir: st.projectDir,
          sessionId,
          prompt,
          env: modelEnv,
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
        return { ok, sessionId: r.sessionId, error: ok ? null : why, secs }
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
  async function bridgeAction({ groupId, cp, flow, st, replyTo }) {
    if (cp.id === 'wrapup') {
      const reqDir = join(st.projectDir, 'docs/requirements', flow.reqId)
      const missing = checkFinalArtifacts(reqDir)
      if (missing.length) {
        await sendPlain(groupId, `收尾检查发现缺产物：${missing.join('、')}`, { replyTo }).catch(() => {})
        return
      }
      await sendPlain(groupId, renderMessage('v2Done', { name: flow.name ?? flow.reqId }, templates), { replyTo }).catch(() => {})
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
    handleMessage({ groupId, text, replyTo: null, st, initiator: null }).catch((e) =>
      log(`[${groupId}] 排队消息处理失败：${e.message}`),
    )
  }

  return { handleMessage }
}

/**
 * 把「用户对上一轮提问的回答」组织成一段有语义的文本。
 *
 * 尝试按位展开成 Q-1 → B 这种形式（读《待提问清单》拿到问题列表），
 * 对不上就原样引用并说明——让 agent 知道这是一串选项字母还是自然语言。
 */
export function buildAnswerBlock(projectDir, reqId, rawAnswer, lastDecisions) {
  const answer = String(rawAnswer ?? '').trim()
  if (!answer) return ''

  // 优先用「上一轮 agent 自己提的问题」：用户回答的就是这些。
  // 没有才退回需求澄清阶段的《待提问清单》——那是 req-prd 回合才适用的旧清单。
  const decisions = Array.isArray(lastDecisions) ? lastDecisions.filter((d) => d?.q) : []
  const questions = decisions.length
    ? decisions.map((d, i) => ({ id: `第 ${i + 1} 条`, title: d.q }))
    : parseQuestionList(join(projectDir, 'docs/requirements', reqId, '待提问清单.md'))
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
    execFileSync('zip', ['-rq', outFile, basename(dir)], { cwd: dirname(dir), stdio: 'ignore' })
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
    return execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
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
function findLatestHap(projectDir) {
  let newest = null
  for (const root of [join(projectDir, 'entry/build'), join(projectDir, 'build')]) {
    for (const f of collectFiles(root, /\.hap$/i)) {
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
