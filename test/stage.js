/**
 * 阶段逻辑单测：回执文案、阶段播报计划、计时起点。
 * 这些函数以前埋在 index.js 里无法import，出过「函数被删只有真跑才报错」的事故。
 *   node test/stage.js
 */
import { resolveStageStart, ackFor, planStageAnnounce, isRequirementDone, heartbeatMessage } from '../src/stage.js'
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

console.log('\n== ackFor：有进行中阶段 + 有待确认事项 ==')
{
  writeBoard(['| 6 测试 | 已完成 | 0 | ok |', '| 7 验收 | 进行中 | 0 | — |'])
  const st2 = {
    stage: '验收',
    stageStartedAt: Date.now() - 5 * 60 * 1000,
    projectDir: root,
    reqId: 'demo',
    waitingLabel: '确认按这两条提交吗',
  }
  const ack = ackFor(st2, 'continue')
  check('报当前阶段和时长', ack.text.includes('当前验收阶段中'), ack.text)
  check('同时带出等待事项', ack.text.includes('确认按这两条提交吗'), ack.text)
  check('等待内容另起一行', ack.text.includes('等你确认：\n'), JSON.stringify(ack.text))
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
  // 还有后续阶段没做，所以不算「全部完成」
  writeBoard(['| 6 测试 | 已完成 | 0 | ok |', '| 7 验收 | 未开始 | 0 | — |'])
  const st = { stage: '测试', stageStartedAt: 0, projectDir: root, reqId: 'demo' }

  check('通过', ackFor(st, 'approve').text.includes('收到批准'), ackFor(st, 'approve').text)
  check('打回', ackFor(st, 'reject').text.includes('收到修改意见'), ackFor(st, 'reject').text)
  check('继续', ackFor(st, 'continue').text.includes('正在继续'), ackFor(st, 'continue').text)
  check('新需求', ackFor(st, 'new_req').text === '收到，开始新需求。', ackFor(st, 'new_req').text)
  check('其他意图回退到等确认', ackFor(st, 'content').text.includes('等你确认'), ackFor(st, 'content').text)
  check('都带已完成阶段名', ackFor(st, 'approve').text.includes('测试阶段已完成'))
}

console.log('\n== ackFor：还有后续阶段时「继续」正常回执 ==')
{
  writeBoard(['| 6 测试 | 已完成 | 0 | ok |', '| 7 验收 | 未开始 | 0 | — |'])
  const st = { stage: '测试', stageStartedAt: 0, projectDir: root, reqId: 'demo' }
  const ack = ackFor(st, 'continue')
  check('没说全部完成', !ack.text.includes('所有阶段都已完成'), ack.text)
  check('回「正在继续」', ack.text.includes('正在继续'), ack.text)
}

console.log('\n== 需求已收尾：任何意图都回「全部完成」 ==')
{
  writeBoard([
    '| 7 验收 | 已完成 | 0 | ok |',
    '| 8 代码提交与合并 | 已完成 | 0 | ok |',
    '| 9 需求收尾 | 已完成 | 0 | ok |',
  ])
  const st = { stage: '需求收尾', stageStartedAt: 0, projectDir: root, reqId: 'demo' }
  for (const intent of ['continue', 'approve', 'reject', 'content']) {
    const ack = ackFor(st, intent)
    check(`${intent} → 全部完成提示`, ack.text.includes('已全部完成'), ack.text)
    check(`${intent} → allDone 标记`, ack.allDone === true)
  }
  // 新需求也拦：一个群只做一个需求，做完仍占着这个群
  const nr = ackFor(st, 'new_req')
  check('new_req 也被拦', nr.text.includes('一个群只做一个需求'), nr.text)
  check('new_req 提示另开群', nr.text.includes('另开一个群'), nr.text)
  check('new_req 也标记 allDone', nr.allDone === true)
}

console.log('\n== 收尾后残留的 waitingLabel 不会盖掉「已完成」 ==')
{
  writeBoard(['| 9 需求收尾 | 已完成 | 0 | ok |'])
  const st = {
    stage: '需求收尾',
    stageStartedAt: 0,
    projectDir: root,
    reqId: 'demo',
    waitingLabel: '确认提交范围',
  }
  const ack = ackFor(st, 'continue')
  check('仍然说全部完成', ack.text.includes('已全部完成'), ack.text)
  check('不提等你确认', !ack.text.includes('等你确认'), ack.text)
}

console.log('\n== isRequirementDone：新流程看「需求收尾」==')
{
  const cases = [
    ['收尾已完成', [{ name: '验收', status: '已完成' }, { name: '需求收尾', status: '已完成' }], true],
    ['收尾进行中', [{ name: '验收', status: '已完成' }, { name: '需求收尾', status: '进行中' }], false],
    ['卡在提交', [{ name: '代码提交与合并', status: '阻塞' }, { name: '需求收尾', status: '未开始' }], false],
    ['老需求全完成', [{ name: '验收', status: '已完成' }], true],
    ['老需求有进行中', [{ name: '验收', status: '进行中' }], false],
    ['空表', [], false],
  ]
  for (const [name, stages, want] of cases) {
    check(name, isRequirementDone(stages) === want, String(isRequirementDone(stages)))
  }
}

console.log('\n== ackFor：idle 标记（空消息是否补引导）==')
{
  writeBoard(['| 1 产品需求 | 进行中 | 0 | — |'])
  const active = ackFor({ stage: null, stageStartedAt: 0, projectDir: root, reqId: 'demo' }, 'content')
  check('有进行中阶段时 idle=false', active.idle === false)

  writeBoard(['| 1 产品需求 | 已完成 | 0 | ok |'])
  const done = ackFor({ stage: '产品需求', stageStartedAt: 1, projectDir: root, reqId: 'demo' }, 'content')
  check('有已完成阶段时 idle=false', done.idle === false)

  // 空的阶段表 = 全新群。注意把它的 mtime 调早，
  // 否则「最近改动的编排记录」会选中它，影响后面按 reqId=null 的用例。
  const emptyDir = join(root, 'docs/requirements/blank')
  mkdirSync(emptyDir, { recursive: true })
  const emptyBoard = join(emptyDir, '编排记录.md')
  writeFileSync(emptyBoard, '# 编排记录：blank\n')
  const old = (Date.now() - 3600 * 1000) / 1000
  utimesSync(emptyBoard, old, old)
  // hasContent=false 表示「只 @ 了 bot、没说内容」——那是要补引导的场景；
  // 空群里真说了需求时回 kickoff 文案，见 test/fresh-group.js
  const blank = ackFor({ stage: null, stageStartedAt: 0, projectDir: root, reqId: 'blank' }, 'content', undefined, {
    hasContent: false,
  })
  check('一个阶段都没有时 idle=true', blank.idle === true, JSON.stringify(blank))
  check('空状态回执是「当前没有进行中的阶段」', blank.text === '当前没有进行中的阶段。', blank.text)
}

console.log('\n== ackFor：绑定丢失时给出 reqId ==')
{
  // 跑过回合的老群才谈得上「绑定丢失」；全新群不猜（见 test/fresh-group.js）
  const st = { stage: null, stageStartedAt: 0, projectDir: root, reqId: null, turn: 3, sessionId: 'sid-1' }
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

console.log('\n== heartbeatMessage：有进行中阶段 ==')
{
  writeBoard(['| 6 测试 | 已完成 | 0 | ok |', '| 7 验收 | 进行中 | 0 | — |'])
  const now = Date.now()
  const st = { stage: '验收', stageStartedAt: now - 5 * 60 * 1000, projectDir: root, reqId: 'demo' }
  const hb = heartbeatMessage(st, now - 30 * 60 * 1000, now)
  check('报阶段心跳', hb.key === 'heartbeat', hb.key)
  check('阶段名正确', hb.vals.stage === '验收', hb.vals.stage)
  check('时长按阶段起点算', hb.vals.duration === '5分钟', hb.vals.duration)
}

console.log('\n== heartbeatMessage：阶段全完成但仍在跑（修复前的静默场景）==')
{
  // 验收完又追加修 bug：阶段表全绿，回合却还在跑。
  // 以前这里返回 null 整条心跳哑掉，群里能安静半小时。
  writeBoard(['| 6 测试 | 已完成 | 0 | ok |', '| 7 验收 | 已完成 | 0 | ok |'])
  const now = Date.now()
  const st = { stage: '需求收尾', stageStartedAt: 0, projectDir: root, reqId: 'demo' }
  const hb = heartbeatMessage(st, now - 31 * 60 * 1000, now)
  check('退回「还在处理中」', hb.key === 'heartbeatRunning', hb.key)
  check('时长按回合起点算', hb.vals.duration === '31分钟', hb.vals.duration)
  check('不再返回空值', hb.key !== null && hb.key !== undefined)
}

console.log('\n== heartbeatMessage：没有编排记录也不哑 ==')
{
  const now = Date.now()
  const st = { stage: null, stageStartedAt: 0, projectDir: root, reqId: 'not-exist' }
  const hb = heartbeatMessage(st, now - 20 * 60 * 1000, now)
  check('仍能给出心跳', hb.key === 'heartbeatRunning', hb.key)
  check('时长合理', hb.vals.duration === '20分钟', hb.vals.duration)
}

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
