/**
 * 决策格式不合规时的自动重写流程。
 *
 * 不启动 bridge，只做结构断言 + 纠正 prompt 内容检查，
 * 防止「重试三次然后才告诉用户」这条链路被改回「直接发原文」。
 *   node test/decision-retry.js
 */
import { readFileSync } from 'node:fs'
import { parseDecision } from '../src/decision.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

console.log('\n== 重试上限 ==')
{
  check('定义了 MAX_DECISION_RETRY', /const MAX_DECISION_RETRY = 3/.test(src))
  check('判断 round <= 上限', /round <= MAX_DECISION_RETRY/.test(src))
}

console.log('\n== 重试链路 ==')
{
  check('有 requestDecisionFix', /async function requestDecisionFix\(/.test(src))
  check('重试时 return（不往下发用户消息）', /await requestDecisionFix[\s\S]{0,200}?\n\s*return\b/.test(src))
  check('重试走 silent 模式', /silent: true/.test(src))
  check('silent 跳过阶段播报', /silent \? \[\] : planned\.messages/.test(src))
}

console.log('\n== 计数 ==')
{
  check('超限后清零', /三次都没改对[\s\S]{0,120}?decisionRetry: 0/.test(src))
  check('成功也清零', /if \(st\.decisionRetry\) persist\(\{ decisionRetry: 0 \}\)/.test(src))
  check('重试前写入 round', /decisionRetry: round/.test(src))
}

console.log('\n== 纠正 prompt 内容 ==')
{
  check('有 decisionFixPrompt', /function decisionFixPrompt\(/.test(src))

  // 从源码里把纠正 prompt 的文本行抽出来，验证它给了正确模板
  const block = src.slice(src.indexOf('function decisionFixPrompt'), src.indexOf('/**\n * 静默让 agent 重写'))
  check('给出 [[ASK]] 标记示例', block.includes("'  [[ASK]]'"))
  check('示例用「1. 」编号', block.includes("'  1. <事项标题>'"))
  check('示例用「A. 」选项', block.includes("'     A. <选项>'"))
  check('要求缩进 3 空格', block.includes('缩进 3 个空格'))
  check('禁止开场白小结', block.includes('不写开场白'))
  check('说明最多 4 个选项', block.includes('最多 4 个'))
  check('要求只重发标记段', block.includes('不要重复已经说过的正文'))
}

console.log('\n== 纠正 prompt 里给的模板本身能通过校验 ==')
{
  // 把示例里的占位符替换成真内容，喂给 parseDecision 应能通过
  const sample = `1. 事项标题
   A. 选项
   B. 选项
2. 事项标题
   A. 选项
   B. 选项`
  const r = parseDecision(sample)
  check('模板形状可解析', r.ok, r.reason)
  check('解析出 2 项', r.ok && r.items.length === 2)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
