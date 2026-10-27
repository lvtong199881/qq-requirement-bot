/**
 * 编排记录渲染单测。
 *
 * v2 下这份文档由 bridge 从状态机生成，是人和面板唯一的进度来源，
 * 所以「状态推导对不对」值得单独测——它错了，群里说得对、面板显示错，
 * 排查起来最费劲。
 *   node test/board.js
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderBoard, writeBoard } from '../src/board.js'
import { initialState } from '../src/flow.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const base = (patch = {}) => ({ ...initialState({ reqId: 'demo', projectDir: '/tmp/x' }), ...patch })

console.log('\n== 刚受理：第一步进行中 ==')
{
  const text = renderBoard(base({ requestText: '首页加个欢迎弹窗' }), { now: 0 })
  check('标题带需求标识', text.includes('# 编排记录：demo'))
  check('记了需求描述', text.includes('首页加个欢迎弹窗'))
  check('状态是进行中', text.includes('当前状态：进行中'))
  check('当前阶段是需求澄清', text.includes('当前阶段：需求澄清'))
  check('表格含表头', text.includes('| 阶段 | 状态 | 返工次数 | 备注 |'))
  check('第一步标进行中', /\| 需求澄清 \| 进行中 \|/.test(text), text)
  check('后面的标未开始', /\| 设计 \| 未开始 \|/.test(text))
  check('没有把分支路径混进主链', !text.includes('| 评审修正 |'))
}

console.log('\n== 跑到中段：前面的已完成 ==')
{
  const text = renderBoard(base({ current: 'dev', status: 'running' }), { now: 0 })
  check('需求澄清已完成', /\| 需求澄清 \| 已完成 \|/.test(text))
  check('技术方案已完成', /\| 技术方案 \| 已完成 \|/.test(text))
  check('开发进行中', /\| 开发 \| 进行中 \|/.test(text))
  check('评审未开始', /\| 代码评审 \| 未开始 \|/.test(text))
}

console.log('\n== 等用户确认 ==')
{
  const text = renderBoard(
    base({
      current: 'req-questions',
      status: 'waiting_user',
      waiting: { checkpointId: 'req-questions', decisions: [{ q: '弹窗时机？', options: [{ text: '首次启动', recommended: true }] }] },
    }),
    { now: 0 },
  )
  check('状态是等你确认', text.includes('当前状态：等你确认'))
  check('有待决策段', text.includes('## 待决策'))
  check('问题渲染出来', text.includes('弹窗时机？'))
  check('推荐项标注', text.includes('A. 首次启动（推荐）'))
}

console.log('\n== 卡住 ==')
{
  const text = renderBoard(
    base({
      current: 'review',
      status: 'blocked',
      rounds: { fix: 3 },
      waiting: { checkpointId: 'review', reason: '评审返工 3 轮仍有 2 项未闭环' },
    }),
    { now: 0 },
  )
  check('状态是卡住了', text.includes('当前状态：卡住了'))
  check('有停点记录', text.includes('## 停点记录'))
  check('原因写进去', text.includes('返工 3 轮'))
  check('备注列体现修正轮次', text.includes('评审修正 3 轮'))
}

console.log('\n== 提交等待与收尾 ==')
{
  const commitText = renderBoard(
    base({ current: 'merge', status: 'waiting_user', waiting: { checkpointId: 'merge', advanceTo: 'wrapup' } }),
    { now: 0 },
  )
  check('合并阶段标注等待确认', commitText.includes('| 合并 | 等待确认 |'), commitText)

  const doneText = renderBoard(base({ current: null, status: 'done' }), { now: 0 })
  check('完成了', doneText.includes('当前状态：已完成'))
  check('没有当前阶段', doneText.includes('当前阶段：已结束'))
}

console.log('\n== writeBoard ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  const flow = base({ requestText: 'x' })
  const ok = writeBoard(dir, flow, { now: 0 })
  check('写成功', ok)
  check('文件存在', existsSync(join(dir, '编排记录.md')))
  const text = readFileSync(join(dir, '编排记录.md'), 'utf8')
  check('内容完整', text.includes('# 编排记录：demo'))
  check('自动生成的提示在', text.includes('本文件由 bridge 从状态机自动生成'))
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
