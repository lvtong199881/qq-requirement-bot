/**
 * 阶段逻辑单测：回执文案、阶段播报计划、计时起点。
 * 这些函数以前埋在 index.js 里无法import，出过「函数被删只有真跑才报错」的事故。
 *   node test/stage.js
 */
import { resolveStageStart, ackFor, planStageAnnounce } from '../src/stage.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'stagejs-'))
const dir = join(root, 'docs/requirements/demo')
mkdirSync(dir, { recursive: true })
const board = join(dir, '编排记录.md')

function writeBoard(rows) {
  writeFileSync(board, [
    '# 编排记录：demo', '', '## 阶段进度',
    '| 阶段 | 状态 | 返工次数 | 校验结论 |', '| --- | --- | --- | --- |',
    ...rows, '', '## 下一节',
  ].join('\n'))
}
const age = (ms) => {
  const t = (Date.now() - ms) / 1000
  utimesSync(board, t, t)
}

console.log('\n== ackFor：有进行中阶段 ==')
{
  writeBoard(['| 6 测试 | 已完成 | 0 | ok |', '| 7 验收 | 进行中 | 0 | — |'])
  age(5 * 60 * 1000)

  const st = { stage: '验收', stageStartedAt: Date.now() - 5 * 60 * 1000, projectDir: root, reqId: 'demo' }
  const ack = ackFor(st, 'continue')
  check('回执是当前阶段状态', ack.text.startsWith('当前验收阶段中，已进行'), ack.text)
  check('已绑定时不建议改 reqId', ack.reqIdToBind === null)
}

console.log('\n== ackFor：阶段刚切换（state 还是旧阶段）==')
{
  // state 说「测试」，编排记录说「验收」
  const st = { stage: '测试', stageStartedAt: Date.now() - 77 * 60 * 1000, projectDir: root, reqId: 'demo' }
  const ack = ackFor(st, 'continue')
  check('阶段名用实时值「验收」', ack.text.includes('验收'), ack.text)
  check('时长不沿用测试的 77 分钟', !ack.text.includes('77'), ack.text)
}

console.log('\n== ackFor：没有进行中阶段，按意图区分 ==')
{
  writeBoard(['| 6 测试 | 已完成 | 0 | ok |'])
  const st = { stage: '测试', stageStartedAt: 0, projectDir: root, reqId: 'demo' }

  check('通过', ackFor(st, 'approve').text.includes('收到批准'), ackFor(st, 'approve').text)
  check('打回', ackFor(st, 'reject').text.includes('收到修改意见'), ackFor(st, 'reject').text)
  check('继续', ackFor(st, 'continue').text.includes('正在继续'), ackFor(st, 'continue').text)
  check('新需求', ackFor(st, 'new_req').text === '收到，开始新需求。', ackFor(st, 'new_req').text)
  check('其他意图回退到等确认', ackFor(st, 'content').text.includes('等你确认'), ackFor(st, 'content').text)
  check('都带已完成阶段名', ackFor(st, 'approve').text.includes('测试阶段已完成'))
}

console.log('\n== ackFor：绑定丢失时给出 reqId ==')
{
  const st = { stage: null, stageStartedAt: 0, projectDir: root, reqId: null }
  const ack = ackFor(st, 'continue')
  check('建议写回 reqId', ack.reqIdToBind === 'demo', String(ack.reqIdToBind))
}

console.log('\n== planStageAnnounce：首次观测不播历史阶段 ==')
{
  writeBoard(['| 1 产品需求 | 已完成 | 0 | ok |', '| 2 设计 | 进行中 | 0 | — |'])
  const st = { stage: null, stageStartedAt: 0, projectDir: root, reqId: 'demo', finishedStages: null }
  const p = planStageAnnounce(st)
  // 首次观测：历史「已完成」阶段不重播，但当前「进行中」阶段要报一次已开始
  check('不重播历史已完成阶段', !p.messages.some((m) => m.includes('已完成')), JSON.stringify(p.messages))
  check('播报当前阶段已开始', p.messages.includes('设计阶段已开始。'), JSON.stringify(p.messages))
  check('记下已知完成阶段', JSON.stringify(p.patch.finishedStages) === '["产品需求"]')
}

console.log('\n== planStageAnnounce：阶段切换播「已开始」 ==')
{
  writeBoard(['| 1 产品需求 | 已完成 | 0 | ok |', '| 2 设计 | 进行中 | 0 | — |'])
  const st = { stage: '产品需求', stageStartedAt: 1, projectDir: root, reqId: 'demo', finishedStages: [] }
  const p = planStageAnnounce(st)
  // 完成与开始合成一条：「产品需求阶段已完成，设计阶段已开始。」
  check(
    '完成与开始合并成一条',
    p.messages.length === 1 && p.messages[0] === '产品需求阶段已完成，设计阶段已开始。',
    JSON.stringify(p.messages),
  )
  check('patch 更新 stage', p.patch.stage === '设计')
  check('patch 更新计时起点', p.patch.stageStartedAt > 0)
}

console.log('\n== planStageAnnounce：新完成阶段播「已完成」 ==')
{
  writeBoard(['| 1 产品需求 | 已完成 | 0 | ok |', '| 2 设计 | 已完成 | 0 | ok |', '| 3 技术方案 | 进行中 | 0 | — |'])
  const st = { stage: '技术方案', stageStartedAt: 1, projectDir: root, reqId: 'demo', finishedStages: ['产品需求'] }
  const p = planStageAnnounce(st)
  check('只有完成时单报完成', p.messages.length === 1 && p.messages[0] === '设计阶段已完成。', JSON.stringify(p.messages))
  check('不重播产品需求', !p.messages.some((m) => m.includes('产品需求')))
}

console.log('\n== planStageAnnounce：只切换阶段、无新增完成 ==')
{
  writeBoard(['| 1 产品需求 | 已完成 | 0 | ok |', '| 2 设计 | 进行中 | 0 | — |'])
  const st = { stage: null, stageStartedAt: 0, projectDir: root, reqId: 'demo', finishedStages: ['产品需求'] }
  const p = planStageAnnounce(st)
  check('只报已开始', p.messages.length === 1 && p.messages[0] === '设计阶段已开始。', JSON.stringify(p.messages))
}

console.log('\n== resolveStageStart ==')
{
  const at = Date.now() - 10 * 60 * 1000
  check('阶段一致时用原值', resolveStageStart({ stage: '验收', stageStartedAt: at, projectDir: root, reqId: 'demo' }, '验收') === at)
  const fixed = resolveStageStart({ stage: '测试', stageStartedAt: at, projectDir: root, reqId: 'demo' }, '验收')
  check('阶段不一致时重估', fixed !== at)
  check('无阶段名返回 null', resolveStageStart({ projectDir: root, reqId: 'demo' }, null) === null)
}

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
