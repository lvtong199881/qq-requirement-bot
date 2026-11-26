/**
 * v2 回合循环：驱动状态机一路往下跑，直到需要停下。
 *
 * 一个「回合」在这里不是「一次群消息」，而是「一次群消息触发的连续推进」：
 * 需求定稿完了可能直接进设计，设计完了直接进技术方案，中间不用等人。
 * 每推进一个 checkpoint 就起一次独立 dsh 进程，出现以下三种情况才停：
 *   · wait_user  要用户回答/拍板（需求澄清、agent 主动问）
 *   · blocked    卡住或返工超限，交用户决策
 *   · 流程走完    所有 checkpoint 结束
 *
 * 副作用全部通过 ctx 注入，所以这个循环可以用假的 runAgent 单测，
 * 不需要起真进程。这是它比旧版 handler 好测的地方。
 */
import { advance, currentCheckpoint, needsAgent, settleParallel, isParallel, getCheckpoint } from './flow.js'
import { buildPrompt, readReceiptWithRetry, verifyOutputs, readSkill, clearReceipt } from './orchestrator.js'

/** 防御性上限：正常流程十几个 checkpoint，到 100 一定是状态机出了问题 */
const MAX_STEPS = 100

/**
 * 跑并行 wave 里的一个分支（内部就是单个 checkpoint 的一轮回合）。
 * 与主循环的回合体一致，但等待/阻塞要带出 wave 上下文。
 * @returns {{state: object, waitStop?: boolean}} waitStop=true 表示这轮要停（等用户/阻塞）
 */
async function runBranch({ state, cp, ctx }) {
  await ctx.onCheckpointStart?.(cp)

  const reqDir = ctx.reqDirOf ? ctx.reqDirOf(state) : ctx.reqDir
  clearReceipt(reqDir, cp.id)

  const skill = readSkill(ctx.skillsDir, cp.role)
  if (!skill.ok) throw new Error(skill.reason)

  const prompt = buildPrompt({ checkpoint: cp, state, skillText: skill.text, vars: ctx.varsFor?.(cp, state) ?? {} })
  const sessionId = cp.id === 'merge' ? null : (state.roleSessions?.[cp.role] ?? null)
  const result = await ctx.runAgent({ role: cp.role, checkpoint: cp, prompt, sessionId })

  if (result?.sessionId) {
    state = { ...state, roleSessions: { ...state.roleSessions, [cp.role]: result.sessionId } }
  }

  const receiptResult = await readReceiptWithRetry(reqDir, cp.id, {
    // 调用方可注入「读之前的兜底」（如 merge 回执写偏工作区的恢复）；
    // 每次重试前都调一次，agent 晚落盘 + 落错位置两种情况都能接住。
    beforeAttempt: ctx.beforeReadReceipt
      ? () => ctx.beforeReadReceipt(state, cp.id)
      : undefined,
  })
  const usable = result?.ok === true || receiptResult.ok
  const verify = usable
    ? verifyOutputs({ checkpoint: cp, reqDir, gitDiff: ctx.gitDiff() })
    : { ok: false, missing: [], reason: result?.error ?? '回合失败' }

  // 分支内失败不推进 wave——advance 会按该分支自身处理 retry（自环不变 current 数组）
  const adv = advance(state, receiptResult.receipt ?? null, verify, {
    requireApproval: ctx.requireApproval === true,
  })
  ctx.persist(adv.state)
  await ctx.onCheckpointEnd?.(cp, adv, receiptResult.receipt ?? null, receiptResult.reason)

  const stop = adv.action === 'wait_user' || adv.action === 'blocked'
  return { state: adv.state, waitStop: stop ? true : undefined }
}

/**
 * @param {object} o
 * @param {object} o.flow 流状态（flow.js 的 initialState 结构 + roleSessions/vars）
 * @param {object} o.ctx
 *   @param {string}   o.ctx.skillsDir
 *   @param {string}   o.ctx.reqDir        需求目录（docs/requirements/<reqId>）
 *   @param {Function} o.ctx.runAgent      ({role, prompt, sessionId}) => {ok, sessionId, error}
 *   @param {Function} o.ctx.gitDiff       () => string
 *   @param {Function} o.ctx.persist       (flow) => void
 *   @param {Function} [o.ctx.varsFor]     (checkpoint, flow) => 占位符变量
 *   @param {Function} [o.ctx.onCheckpointStart] (checkpoint) => void
 *   @param {Function} [o.ctx.onCheckpointEnd]   (checkpoint, adv, receipt) => void
 *   @param {Function} [o.ctx.onBridgeCheckpoint](checkpoint) => Promise<void>
 * @returns {Promise<{flow: object, done: boolean, stoppedAt: string|null}>}
 */
export async function runFlow({ flow, ctx }) {
  let state = flow
  let steps = 0

  while (steps++ < MAX_STEPS) {
    const cp = currentCheckpoint(state)
    if (!cp) return { flow: state, done: true, stoppedAt: null }

    // ── 并行 wave：current 是数组，按清单顺序把每个分支各跑一轮 ──
    // 这里是「顺序跑」不是真并发：一个 dsh 回合就是一整个模型会话+构建，
    // 并发抢执行槽和模拟器只会互相拖慢。并行的价值在图上（结构表达），
    // 不在墙上时钟——真要提速先扩执行槽。
    if (isParallel(state)) {
      const wave = state.current
      const done = []
      for (const id of wave) {
        const branchCp = getCheckpoint(id)
        const r = await runBranch({ state, cp: branchCp, ctx })
        if (r.waitStop) return { flow: r.state, done: false, stoppedAt: id }
        state = r.state
        // 分支达标 → 销账；清单空了拿到汇合点，进 join
        const join = settleParallel(state, id)
        done.push(id)
        if (join) {
          state = { ...state, current: join, status: 'running' }
          ctx.persist(state)
          break
        }
      }
      continue
    }

    // ── bridge 自己的 checkpoint：wrapup ──
    // 它们不派 agent，动作由调用方实现（git、终检），状态直接推进。
    if (!needsAgent(cp)) {
      await ctx.onBridgeCheckpoint?.(cp, state)
      const r = advance(state, null, { ok: true })
      state = r.state
      ctx.persist(state)
      if (state.status === 'done') return { flow: state, done: true, stoppedAt: null }
      // commit 这类要用户确认的 bridge 动作：停下来等，不要 continue 冲过去
      if (r.action === 'wait_user') return { flow: state, done: false, stoppedAt: cp.id }
      continue
    }

    await ctx.onCheckpointStart?.(cp)

    // 产物目录在 onCheckpointStart 之后解析：dev 的这一步会把 workDir 写进
    // 状态（暂存区 → 工作区），回执、清旧回执、产物校验要跟着这个新目录走。
    // 用注入的函数每轮重取，而不是开局算死的一份——开局算的永远是暂存区，
    // dev 之后的回执和 agent 产物就分家了（实测踩过）。
    const reqDir = ctx.reqDirOf ? ctx.reqDirOf(state) : ctx.reqDir

    // 清掉上一轮回执：不清的话，agent 这一轮没写回执时会把旧的当新的读
    clearReceipt(reqDir, cp.id)

    const skill = readSkill(ctx.skillsDir, cp.role)
    if (!skill.ok) {
      // 角色卡缺失是配置问题，不是 agent 的错，直接抛给上层报人为故障
      throw new Error(skill.reason)
    }

    const prompt = buildPrompt({
      checkpoint: cp,
      state,
      skillText: skill.text,
      vars: ctx.varsFor?.(cp, state) ?? {},
    })

    // 续跑会话按角色取。但 merge 例外：它虽然也是 dev 角色，工作区却是
    // 专用合并工作区（worktrees/_merge），与开发工作区目录不同——dsh 会校验
    // 会话原始目录和当前 cwd，拿 dev 的旧会话续跑必然报
    // "was recorded in ..., not ..."。merge 总是开新会话。
    const sessionId =
      cp.id === 'merge' ? null : (state.roleSessions?.[cp.role] ?? null)
    const result = await ctx.runAgent({ role: cp.role, checkpoint: cp, prompt, sessionId })

    // 回合结束就把 session 记下来：即使这一轮失败了，续跑也要接同一个会话
    if (result?.sessionId) {
      state = { ...state, roleSessions: { ...state.roleSessions, [cp.role]: result.sessionId } }
    }

    // 进程异常退出时也先看回执：agent 可能已经把产物写完、回执也落了，
    // 只是收尾时挂住（工具卡死、超时）。这种情况重跑一遍代价很大，产物却是真的。
    // 但不能无条件信产物——中途崩溃时上一轮的旧文件还在，会误判通过，
    // 所以判据是「进程成功 或 回执合法」，两者都不成立才走返工。
    // 读不到不立刻下结论：agent 落盘比进程退出晚是常态（竞态），轮询等它。
    const receiptResult = await readReceiptWithRetry(reqDir, cp.id, {
      // 调用方可注入「读之前的兜底」（如 merge 回执写偏工作区的恢复）；
      // 每次重试前都调一次，agent 晚落盘 + 落错位置两种情况都能接住。
      beforeAttempt: ctx.beforeReadReceipt
        ? () => ctx.beforeReadReceipt(state, cp.id)
        : undefined,
    })
    const usable = result?.ok === true || receiptResult.ok
    const verify = usable
      ? verifyOutputs({ checkpoint: cp, reqDir, gitDiff: ctx.gitDiff() })
      : { ok: false, missing: [], reason: result?.error ?? '回合失败' }

    const adv = advance(state, receiptResult.receipt ?? null, verify, {
      requireApproval: ctx.requireApproval === true,
    })
    state = adv.state
    ctx.persist(state)

    await ctx.onCheckpointEnd?.(cp, adv, receiptResult.receipt ?? null, receiptResult.reason)

    if (adv.action === 'wait_user' || adv.action === 'blocked') {
      return { flow: state, done: false, stoppedAt: cp.id }
    }
    // retry：同一 checkpoint 再跑一轮（advance 里已经计过数、也判过上限）
    // continue：进入下一 checkpoint。两种都只是继续循环。
  }

  throw new Error(`流程循环超过 ${MAX_STEPS} 步，疑似状态机死循环`)
}
