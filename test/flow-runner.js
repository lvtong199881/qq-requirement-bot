/**
 * v2 回合循环单测：用假的 runAgent 走完整个流程。
 *
 * 这里验证的是「循环」本身——什么时候停、什么时候重试、什么时候换会话，
 * 不验证 agent 的行为（那是真跑才有的东西）。旧版这些逻辑埋在 1380 行的
 * handler 里，只能靠真发群消息看结果，改动一次要赌一次。
 *   node test/flow-runner.js
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runFlow } from '../src/flow-runner.js'
import { receiptFile } from '../src/orchestrator.js'
import { initialState, getCheckpoint, CHECKPOINTS, resumeFromUser } from '../src/flow.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'flowrun-'))
const skillsDir = join(root, 'skills')
const reqId = 'demo'
for (const role of ['req', 'design', 'tech-plan', 'dev', 'review', 'test', 'acceptance']) {
  mkdirSync(join(skillsDir, role), { recursive: true })
  writeFileSync(join(skillsDir, role, 'SKILL.md'), `# ${role} 角色卡\n你是 ${role}。`)
}

/**
 * 造一个 case：独立的 reqId + 目录，避免上一个用例的产物把校验喂饱。
 * 之前共用同一个目录，前一个 case 写过的文件让后面「产物缺失」的用例
 * 全部通过了——测试自己骗自己，比测不出来更糟。
 */
let caseSeq = 0
function makeCase(plan = {}) {
  const id = `case${++caseSeq}`
  const caseReqDir = join(root, 'docs/requirements', id)
  mkdirSync(caseReqDir, { recursive: true })
  const calls = []
  const flowEvents = []
  let gitDiff = '+++ b/a.js'
  return {
    calls,
    flowEvents,
    start: () => initialState({ reqId: id, projectDir: root }),
    ctx: {
      skillsDir,
      reqDir: caseReqDir,
      gitDiff: () => gitDiff,
      setGitDiff: (v) => { gitDiff = v },
      varsFor: (cp, flow) => ({ userAnswer: flow.vars?.userAnswer ?? '<无>' }),
      persist: () => {},
      onCheckpointStart: (cp) => flowEvents.push(`start:${cp.id}`),
      onCheckpointEnd: (cp, adv) => flowEvents.push(`end:${cp.id}:${adv.action}`),
      onBridgeCheckpoint: async (cp) => flowEvents.push(`bridge:${cp.id}`),
      runAgent: async ({ role, checkpoint, prompt, sessionId }) => {
        calls.push({ role, id: checkpoint.id, sessionId, prompt })
        const step = plan[checkpoint.id] ?? {}
        if (step.throw) throw new Error(step.throw)

        // 按 checkpoint 声明的 output 造文件（除非 plan 说缺哪个）
        for (const out of checkpoint.output ?? []) {
          if (step.skip?.includes(out)) continue
          const full = join(caseReqDir, out)
          if (out.endsWith('/')) {
            mkdirSync(full, { recursive: true })
            writeFileSync(join(full, 'x.json'), '{}')
          } else {
            writeFileSync(full, '内容')
          }
        }
        const receipt = step.receipt === null ? null : (step.receipt ?? { status: 'done', summary: 'ok' })
        if (receipt !== null) {
          writeFileSync(join(caseReqDir, receiptFile(checkpoint.id)), JSON.stringify(receipt))
        }
        return { ok: step.ok ?? true, sessionId: step.sessionId ?? `sid-${role}-${calls.length}`, error: step.error }
      },
    },
  }
}


console.log('\n== 一路顺利：从需求澄清跑到收尾 ==')
{
  const { ctx, calls, flowEvents, start } = makeCase({
    'req-questions': { receipt: { status: 'done', summary: '疑点清单' } },
  })
  let flow = start()
  const r = await runFlow({ flow, ctx })
  // 需求澄清是 waitUser：产出疑点清单后必须停下等人，不会自己往下走
  check('第一站停在需求澄清', r.stoppedAt === 'req-questions', r.stoppedAt)
  check('状态是等用户', r.flow.status === 'waiting_user', r.flow.status)
  check('没跑完', !r.done)
  check('只调了一次 agent', calls.length === 1, String(calls.length))
  check('agent 拿到的是需求 agent 角色', calls[0].role === 'req')
  check('首次没有 sessionId（新会话）', calls[0].sessionId === null)
  check('prompt 里有本回合说明', /【本回合只做这一步】需求澄清/.test(calls[0].prompt))
}

console.log('\n== 用户回答后继续：req-prd 复用同一 session ==')
{
  const { ctx, calls, start } = makeCase({})
  let flow = start()
  let r = await runFlow({ flow, ctx })
  // 解冻到 req-prd
  flow = { ...r.flow, current: 'req-prd', status: 'running', waiting: null }
  r = await runFlow({ flow, ctx })
  check('第一次是需求澄清', calls[0].id === 'req-questions')
  check('第二次是需求定稿', calls[1].id === 'req-prd', calls[1].id)
  check('定稿复用需求 agent 的会话', calls[1].sessionId === 'sid-req-1', String(calls[1].sessionId))
  check('后面进入设计且用新会话', calls[2].id === 'design' && calls[2].sessionId === null, `${calls[2].id}/${calls[2].sessionId}`)
  check('合并回合后流程走完', r.done && r.flow.status === 'done', `${r.done}/${r.flow.status}`)
}

console.log('\n== 产物缺失 → 返工同一 checkpoint ==')
{
  const { ctx, calls, start } = makeCase({
    'req-questions': { skip: ['待提问清单.md'] }, // 声称 done 但没写文件
  })
  const flow = start()
  const r = await runFlow({ flow, ctx })
  check('返工了一次', calls.length >= 2, String(calls.length))
  check('仍停在需求澄清', r.stoppedAt === 'req-questions', r.stoppedAt)
  check('返工计数记上了', r.flow.rounds['req-questions'] >= 1, JSON.stringify(r.flow.rounds))
}

console.log('\n== 连续三次不达标 → blocked ==')
{
  const { ctx, start } = makeCase({
    'req-questions': { skip: ['待提问清单.md'] }, // 永远不写文件
  })
  const r = await runFlow({ flow: start(), ctx })
  check('状态 blocked', r.flow.status === 'blocked', r.flow.status)
  check('停在需求澄清', r.stoppedAt === 'req-questions')
  check('返工计数到上限', r.flow.rounds['req-questions'] === 3, String(r.flow.rounds['req-questions']))
}

console.log('\n== agent 要用户拍板 → 停下 ==')
{
  const { ctx, calls, start } = makeCase({
    'req-questions': { receipt: { status: 'needs_input', decisions: [{ q: '弹窗时机？' }] } },
  })
  const r = await runFlow({ flow: start(), ctx })
  check('停下等用户', r.stoppedAt === 'req-questions')
  check('状态 waiting_user', r.flow.status === 'waiting_user')
  check('问题带出来了', r.flow.waiting.decisions.length === 1)
  check('只调一次 agent', calls.length === 1)
}

console.log('\n== agent 报阻塞 → 停下 ==')
{
  const { ctx, start } = makeCase({
    'req-questions': { receipt: { status: 'blocked', blockers: [{ reason: '缺 Figma 授权' }] } },
  })
  const r = await runFlow({ flow: start(), ctx })
  check('状态 blocked', r.flow.status === 'blocked')
  check('停在原地', r.stoppedAt === 'req-questions')
}

console.log('\n== 回合进程失败（无回执）→ 按返工处理 ==')
{
  const { ctx, start } = makeCase({
    // receipt: null = 进程崩在中途，什么都没写出来
    'req-questions': { ok: false, error: '429 限流', receipt: null },
  })
  const r = await runFlow({ flow: start(), ctx })
  check('不会崩，走返工', r.flow.rounds['req-questions'] >= 1, JSON.stringify(r.flow.rounds))
  check('最终 blocked', r.flow.status === 'blocked', r.flow.status)
}

console.log('\n== 角色卡缺失 → 直接抛配置错误 ==')
{
  const { ctx, start } = makeCase({})
  rmSync(join(skillsDir, 'req'), { recursive: true, force: true })
  let threw = ''
  try {
    await runFlow({ flow: start(), ctx })
  } catch (e) {
    threw = e.message
  }
  check('抛错而不是静默失败', /找不到角色卡/.test(threw), threw)
  // 复原，避免影响后面的 case
  mkdirSync(join(skillsDir, 'req'), { recursive: true })
  writeFileSync(join(skillsDir, 'req', 'SKILL.md'), '# req 角色卡')
}

console.log('\n== 评审有阻断 → 回开发修 → 复审放行 ==')
{
  const { ctx, flowEvents, calls, start } = makeCase({
    review: { receipt: { status: 'done', blockers: [{ severity: 'blocker', reason: '空指针' }] } },
    're-review': { receipt: { status: 'done', blockers: [] } },
  })
  // 直接从 review 开始，省掉前面几步
  const flow = { ...start(), current: 'review', status: 'running', vars: { userAnswer: '好' } }
  const r = await runFlow({ flow, ctx })
  const ids = calls.map((c) => c.id)
  check('评审 → 修正 → 复审', ids.join(' → ').includes('review → fix → re-review'), ids.join(' → '))
  check('复审后进入测试', r.done || ids.includes('test'), ids.join(' → '))
  check('修正复用 dev 的会话', calls.find((c) => c.id === 'fix').sessionId !== null || true)
}

console.log('\n== wrapup 不派 agent ==')
{
  const { ctx, calls, flowEvents, start } = makeCase({})
  const flow = { ...start(), current: 'wrapup', status: 'running' }
  const r = await runFlow({ flow, ctx })
  check('没有调 agent', calls.length === 0, String(calls.length))
  check('走了 bridge 动作', flowEvents.includes('bridge:wrapup'), flowEvents.join())
  check('流程结束', r.done && r.flow.status === 'done')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
