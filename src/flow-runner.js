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
import { advance, currentCheckpoint, needsAgent } from './flow.js'
import { buildPrompt, readReceipt, verifyOutputs, readSkill, clearReceipt } from './orchestrator.js'

/** 防御性上限：正常流程十几个 checkpoint，到 100 一定是状态机出了问题 */
const MAX_STEPS = 100

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

    // ── bridge 自己的 checkpoint：commit / wrapup ──
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

    // 清掉上一轮回执：不清的话，agent 这一轮没写回执时会把旧的当新的读
    clearReceipt(ctx.reqDir, cp.id)

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

    const sessionId = state.roleSessions?.[cp.role] ?? null
    const result = await ctx.runAgent({ role: cp.role, checkpoint: cp, prompt, sessionId })

    // 回合结束就把 session 记下来：即使这一轮失败了，续跑也要接同一个会话
    if (result?.sessionId) {
      state = { ...state, roleSessions: { ...state.roleSessions, [cp.role]: result.sessionId } }
    }

    // 进程异常退出时也先看回执：agent 可能已经把产物写完、回执也落了，
    // 只是收尾时挂住（工具卡死、超时）。这种情况重跑一遍代价很大，产物却是真的。
    // 但不能无条件信产物——中途崩溃时上一轮的旧文件还在，会误判通过，
    // 所以判据是「进程成功 或 回执合法」，两者都不成立才走返工。
    const receiptResult = readReceipt(ctx.reqDir, cp.id)
    const usable = result?.ok === true || receiptResult.ok
    const verify = usable
      ? verifyOutputs({ checkpoint: cp, reqDir: ctx.reqDir, gitDiff: ctx.gitDiff() })
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
