/**
 * 流程状态机单测。
 *
 * 这是重构后桥接层最核心的纯逻辑：阶段推进、返工计数、评审闸门、
 * 等用户回答。它不碰 fs、不派回合，所以可以在这里把每条边都走一遍——
 * 旧版这些判断散在 index.js 里，只能靠「真跑一次群消息」验证。
 *   node test/flow.js
 */
import {
  CHECKPOINTS,
  MAX_RETRY,
  initialState,
  currentCheckpoint,
  advance,
  resumeFromUser,
  needsAgent,
  FIRST_CHECKPOINT,
} from '../src/flow.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const start = () => initialState({ reqId: 'demo', projectDir: '/tmp/demo' })
const ok = (state, extra = {}) =>
  advance(state, { status: 'done', artifacts: [], summary: 'ok', ...extra }, { ok: true })

console.log('\n== 初始状态 ==')
{
  const st = start()
  check('从第一个 checkpoint 开始', st.current === FIRST_CHECKPOINT)
  check('是 req-questions', st.current === 'req-questions')
  check('状态 running', st.status === 'running')
  check('返工计数为空', Object.keys(st.rounds).length === 0)
  check('需要派 agent', needsAgent(currentCheckpoint(st)))
}

console.log('\n== 需求澄清：产出后等用户回答 ==')
{
  const st = start()
  const r = ok(st)
  check('action = wait_user', r.action === 'wait_user', r.action)
  check('状态 waiting_user', r.state.status === 'waiting_user')
  check('停在原 checkpoint', r.state.current === 'req-questions')
  check('记下了下一个 checkpoint', r.state.waiting.advanceTo === 'req-prd')
  check('不往下走', r.state.current !== 'req-prd')
}

console.log('\n== 需求澄清：agent 要用户回答后，解冻要推进到定稿 ==')
{
  const st = start()
  // 关键场景：needs_input 和 waitUser 同时成立
  const r = advance(st, { status: 'needs_input', decisions: [{ q: '弹窗时机？' }] }, { ok: true })
  check('action = wait_user', r.action === 'wait_user', r.action)
  check('记下了下一站 req-prd', r.state.waiting.advanceTo === 'req-prd', JSON.stringify(r.state.waiting))
  const resumed = resumeFromUser(r.state)
  check('回答后推进到 req-prd（不是原地重跑）', resumed.current === 'req-prd', resumed.current)
}

console.log('\n== 用户回答后继续 ==')
{
  const st = ok(start()).state
  const resumed = resumeFromUser(st)
  check('解冻到 req-prd', resumed.current === 'req-prd', resumed.current)
  check('状态回到 running', resumed.status === 'running')
  check('waiting 清空', resumed.waiting === null)
}

console.log('\n== agent 主动要输入后，回答完重跑同一 checkpoint ==')
{
  const st = { ...start(), current: 'tech-plan' }
  const waiting = advance(st, { status: 'needs_input', decisions: [{ q: '选存储' }] }, { ok: true }).state
  check('停在 tech-plan', waiting.current === 'tech-plan')
  const resumed = resumeFromUser(waiting)
  check('仍是 tech-plan', resumed.current === 'tech-plan', resumed.current)
  check('状态回到 running（否则会永远卡住）', resumed.status === 'running', resumed.status)
  check('waiting 清空', resumed.waiting === null)
}

console.log('\n== 需求定稿 → 设计 ==')
{
  const st = resumeFromUser(ok(start()).state)
  const r = ok(st)
  check('action = continue', r.action === 'continue', r.action)
  check('进入 design', r.state.current === 'design', r.state.current)
  check('返回下一个 checkpoint 信息', r.checkpoint.id === 'design')
}

console.log('\n== 产物校验失败 → 返工同一 checkpoint ==')
{
  const st = { ...start(), current: 'design' }
  const r = advance(st, { status: 'done', artifacts: [] }, { ok: false, missing: ['设计说明.md'] })
  check('action = retry', r.action === 'retry', r.action)
  check('停在 design', r.state.current === 'design')
  check('返工计数 +1', r.state.rounds.design === 1, String(r.state.rounds.design))
  check('原因提到缺哪个产物', /设计说明/.test(r.reason ?? ''), r.reason)
}

console.log('\n== 连续失败到上限 → blocked ==')
{
  let st = { ...start(), current: 'design' }
  let action = ''
  for (let i = 0; i < MAX_RETRY; i++) {
    const r = advance(st, { status: 'partial' }, { ok: false })
    st = r.state
    action = r.action
  }
  check(`前 ${MAX_RETRY} 轮都是 retry`, action === 'retry', action)
  const over = advance(st, { status: 'partial' }, { ok: false })
  check('第 4 轮变 blocked', over.action === 'blocked', over.action)
  check('状态 blocked', over.state.status === 'blocked')
}

console.log('\n== agent 报阻塞 ==')
{
  const st = { ...start(), current: 'dev' }
  const r = advance(st, { status: 'blocked', blockers: [{ reason: '缺少 SDK' }] }, { ok: true })
  check('action = blocked', r.action === 'blocked', r.action)
  check('原因带出来', /SDK/.test(r.reason ?? ''), r.reason)
  check('不进入下一阶段', r.state.current === 'dev')
}

console.log('\n== agent 要用户拍板 ==')
{
  const st = { ...start(), current: 'tech-plan' }
  const r = advance(st, {
    status: 'needs_input',
    decisions: [{ q: '选哪个存储方案', options: [{ text: 'SQLite', recommended: true }] }],
  }, { ok: true })
  check('action = wait_user', r.action === 'wait_user', r.action)
  check('问题被带出来', r.state.waiting.decisions.length === 1)
  check('停在原 checkpoint', r.state.current === 'tech-plan')
}

console.log('\n== 评审闸门：有阻断 → 回开发修 ==')
{
  const st = { ...start(), current: 'review' }
  const r = advance(st, {
    status: 'done',
    blockers: [{ severity: 'blocker', reason: '空指针未处理' }],
  }, { ok: true })
  check('进入 fix', r.state.current === 'fix', r.state.current)
  check('修一轮计数 +1', r.state.rounds.fix === 1)
}

console.log('\n== 评审闸门：只剩建议项 → 放行测试 ==')
{
  const st = { ...start(), current: 'review' }
  const r = advance(st, {
    status: 'done',
    blockers: [{ severity: 'suggestion', reason: '命名可以更好' }],
  }, { ok: true })
  check('进入 test', r.state.current === 'test', r.state.current)
  check('不计入返工', !r.state.rounds.fix)
}

console.log('\n== 评审闸门：返工超限 → 停下等用户 ==')
{
  const st = { ...start(), current: 'review', rounds: { fix: MAX_RETRY } }
  const r = advance(st, {
    status: 'done',
    blockers: [{ severity: 'blocker', reason: '还是有问题' }],
  }, { ok: true })
  check('action = blocked', r.action === 'blocked', r.action)
  check('原因说明返工超限', /返工/.test(r.reason ?? ''), r.reason)
}

console.log('\n== 修正 → 复审 → 放行 ==')
{
  let st = { ...start(), current: 'review' }
  st = advance(st, { status: 'done', blockers: [{ severity: 'blocker', reason: 'x' }] }, { ok: true }).state
  check('到 fix', st.current === 'fix')
  st = advance(st, { status: 'done' }, { ok: true }).state
  check('修完到 re-review', st.current === 're-review', st.current)
  st = advance(st, { status: 'done', blockers: [] }, { ok: true }).state
  check('复审通过到 test', st.current === 'test', st.current)
}

console.log('\n== bridge 自己执行的 checkpoint 不派 agent ==')
{
  const merge = { ...start(), current: 'merge' }
  check('merge 需要 agent（要跑编译）', needsAgent(currentCheckpoint(merge)))
  const r = advance({ ...start(), current: 'wrapup' }, null, { ok: true })


  const wrapup = { ...start(), current: 'wrapup' }
  check('wrapup 不需要 agent', !needsAgent(currentCheckpoint(wrapup)))
}

console.log('\n== 全流程走通 ==')
{
  let st = start()
  const seen = []
  let guard = 0
  while (guard++ < 50) {
    const cp = currentCheckpoint(st)
    if (!cp) break
    seen.push(cp.id)
    if (cp.id === 'review' || cp.id === 're-review') {
      st = advance(st, { status: 'done', blockers: [] }, { ok: true }).state
    } else if (!needsAgent(cp)) {
      const r = advance(st, null, { ok: true })
      st = r.action === 'wait_user' ? resumeFromUser(r.state) : r.state
    } else {
      const r = advance(st, { status: 'done' }, { ok: true })
      st = r.action === 'wait_user' ? resumeFromUser(r.state) : r.state
    }
    if (st.status === 'done') break
  }
  check('走完所有 checkpoint', currentCheckpoint(st) === null, String(currentCheckpoint(st)?.id))
  // 主链不含 fix / re-review：那两个只在评审有问题时才走
  const MAIN = CHECKPOINTS.filter((c) => !['fix', 're-review', 'merge-fix'].includes(c.id)).map((c) => c.id)
  check(`主链 ${MAIN.length} 个 checkpoint`, seen.length === MAIN.length, `${seen.length} vs ${MAIN.length}`)
  check('主链顺序正确', seen.join(' → ') === MAIN.join(' → '), seen.join(' → '))
  check('评审在开发之后、测试之前',
    seen.indexOf('review') > seen.indexOf('dev') && seen.indexOf('review') < seen.indexOf('test'))
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
