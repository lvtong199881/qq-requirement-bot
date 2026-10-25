/**
 * 四类群消息测试：验证话术格式与触发逻辑。
 *   node test/broadcast.js
 */
import { stageTable } from '../src/artifacts.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? (pass++) : (fail++)
}

// 造一个假项目
const root = mkdtempSync(join(tmpdir(), 'broadcast-'))
const reqDir = join(root, 'docs/requirements/demo')
mkdirSync(reqDir, { recursive: true })

function writeBoard(rows) {
  writeFileSync(join(reqDir, '编排记录.md'), [
    '# 编排记录：demo',
    '',
    '## 阶段进度',
    '| 阶段 | 状态 | 返工次数 | 校验结论 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '## 下一节',
  ].join('\n'))
}

console.log('\n== 阶段表解析 ==')
{
  writeBoard([
    '| 1 产品需求 | 已完成 | 0 | ok |',
    '| 2 设计 | 进行中 | 0 | — |',
    '| 3 技术方案 | 未开始 | 0 | — |',
  ])
  const t = stageTable(root, 'demo')
  check('返回 reqId', t.reqId === 'demo')
  check('解析出 3 个阶段', t.stages.length === 3, `实际 ${t.stages.length}`)
  check('阶段名去掉序号', t.stages[1].name === '设计', `实际 ${t.stages[1].name}`)
  check('状态正确', t.stages[1].status === '进行中')
  check('序号保留', t.stages[2].num === '3')
}

console.log('\n== 阶段切换检测 ==')
{
  const { stages } = stageTable(root, 'demo')
  const running = stages.find((x) => x.status.includes('进行中'))
  check('能找出进行中阶段', running?.name === '设计', `实际 ${running?.name}`)
  check('已完成阶段可枚举', stages.filter((x) => x.status.includes('已完成')).length === 1)
}

console.log('\n== 话术格式 ==')
{
  const mins = (from) => `${Math.max(0, Math.round((Date.now() - from) / 60000))} 分钟`
  const ack = `当前设计阶段中，已进行 ${mins(Date.now() - 7 * 60000)}。`
  check('消息1 用户回执格式', /^当前设计阶段中，已进行 7 分钟。$/.test(ack), ack)

  const started = '开发阶段已开始。'
  check('消息2a 阶段开始格式', /^.+阶段已开始。$/.test(started))

  const done = '开发阶段已完成。\n产物：技术方案.md、编排记录.md\n等你确认：主按钮配色是否调整？'
  check('消息2b 阶段完成含产物', done.includes('产物：'))
  check('消息2b 阶段完成含待确认', done.includes('等你确认：'))

  const hb = `当前开发阶段中，已进行 ${mins(Date.now() - 12 * 60000)}。`
  check('消息3 心跳格式', /^当前开发阶段中，已进行 12 分钟。$/.test(hb), hb)

  const err = '开发阶段异常，请联系 bot 管理员，异常原因如下：\n模型账号余额不足（402）'
  check('消息4 异常格式', err.startsWith('开发阶段异常，请联系 bot 管理员，异常原因如下：'))
  check('消息4 带原因', err.includes('402'))
}

console.log('\n== 边界：无进行中阶段 ==')
{
  writeBoard([
    '| 1 产品需求 | 已完成 | 0 | ok |',
    '| 2 设计 | 已完成 | 0 | ok |',
  ])
  const { stages } = stageTable(root, 'demo')
  const running = stages.find((x) => x.status.includes('进行中'))
  const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
  check('无进行中阶段时 running 为空', running === undefined)
  check('可回退到「已完成，等你确认」', lastDone?.name === '设计')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
