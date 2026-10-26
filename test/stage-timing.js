/**
 * 阶段时长：阶段刚切换、回合还没结束时，不能沿用上一阶段的时间戳。
 *   node test/stage-timing.js
 */
import { stageTable, guessStageStart } from '../src/artifacts.js'
import { formatDuration } from '../src/format.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

/** 复刻 index.js 的逻辑（两行，保持同步很容易） */
function resolveStageStart(st, runningName) {
  if (!runningName) return null
  if (st.stage === runningName && st.stageStartedAt) return st.stageStartedAt
  return guessStageStart(st.projectDir, st.reqId)
}

const root = mkdtempSync(join(tmpdir(), 'stage-'))
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

console.log('\n== 阶段已切换，但 state 还停在上一个阶段 ==')
{
  writeBoard(['| 6 测试 | 已完成 | 0 | ok |', '| 7 验收 | 进行中 | 0 | — |'])
  const tenMinAgo = (Date.now() - 10 * 60 * 1000) / 1000
  utimesSync(board, tenMinAgo, tenMinAgo)

  const { stages } = stageTable(root, 'demo')
  const running = stages.find((x) => x.status.includes('进行中'))
  check('进行中阶段是「验收」', running?.name === '验收')

  const stale = {
    stage: '测试',
    stageStartedAt: Date.now() - 77 * 60 * 1000,
    projectDir: root,
    reqId: 'demo',
  }
  const fixed = resolveStageStart(stale, running.name)
  const staleMin = (Date.now() - stale.stageStartedAt) / 60000
  const fixedMin = (Date.now() - fixed) / 60000

  check('不纠正会播成 77 分钟', Math.round(staleMin) === 77, String(Math.round(staleMin)))
  check('纠正后按编排记录估 ≈10 分钟', Math.abs(fixedMin - 10) < 2, fixedMin.toFixed(1))
  console.log(`     修复后播报：当前${running.name}阶段中，已进行 ${formatDuration(Date.now() - fixed)}`)
}

console.log('\n== 阶段一致时沿用已有时间戳 ==')
{
  const at = Date.now() - 30 * 60 * 1000
  const st = { stage: '验收', stageStartedAt: at, projectDir: root, reqId: 'demo' }
  check('不重复估算', resolveStageStart(st, '验收') === at)
}

console.log('\n== 超过 24 小时的旧记录不采信 ==')
{
  writeBoard(['| 7 验收 | 进行中 | 0 | — |'])
  const longAgo = (Date.now() - 48 * 3600 * 1000) / 1000
  utimesSync(board, longAgo, longAgo)
  const got = guessStageStart(root, 'demo')
  check('退回当前时间', Math.abs(Date.now() - got) < 2000)
}

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
