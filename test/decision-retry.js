/**
 * 决策格式不合规时的自动重写流程。
 *
 * 不启动 bridge，只做结构断言 + 纠正 prompt 内容检查，
 * 防止「重试三次然后才告诉用户」这条链路被改回「直接发原文」。
 *   node test/decision-retry.js
 */
import { readFileSync } from 'node:fs'
import { parseDecisionJson, DECISION_JSON_EXAMPLE } from '../src/decision.js'

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
  check('要求 JSON 数组', block.includes('必须是一个 JSON 数组'))
  check('贴出示例常量', block.includes('DECISION_JSON_EXAMPLE'))
  check('说明 q 字段', block.includes('q：问题标题'))
  check('说明 a 字段', block.includes('a：选项数组'))
  check('说明 t 字段', block.includes('t：选项文字'))
  check('说明 r 字段', block.includes('r：是否推荐'))
  check('禁止代码块包裹', block.includes('不要用 markdown 代码块包'))
  check('要求只重发标记段', block.includes('不要重复已经说过的正文'))
}

console.log('\n== 纠正 prompt 贴的示例本身能通过校验 ==')
{
  const r = parseDecisionJson(DECISION_JSON_EXAMPLE)
  check('示例可解析', r.ok, r.reason)
  check('解析出 2 项', r.ok && r.items.length === 2)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
