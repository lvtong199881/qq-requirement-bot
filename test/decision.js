/**
 * 决策内容：agent 给 JSON，bridge 渲染成文本。
 *   node test/decision.js
 */
import { parseDecisionJson, formatDecision, DECISION_JSON_EXAMPLE, DECISION_LIMITS } from '../src/decision.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}
const ok = (name, text) => {
  const r = parseDecisionJson(text)
  check(name, r.ok, r.reason)
  return r
}
const bad = (name, text, kw) => {
  const r = parseDecisionJson(text)
  check(name, !r.ok && (!kw || r.reason.includes(kw)), r.ok ? '竟然通过' : r.reason)
}

const SAMPLE = [
  { q: '问题1', a: [{ t: '答案1', r: true }, { t: '答案2', r: false }] },
  { q: '问题2', a: [{ t: '答案1', r: false }, { t: '答案2', r: true }, { t: '答案3', r: false }] },
]

console.log('\n== 标准 JSON ==')
{
  const r = ok('用户给的结构', JSON.stringify(SAMPLE, null, 2))
  check('两项', r.items.length === 2)
  check('第一项 2 个选项', r.items[0].options.length === 2)
  check('第二项 3 个选项', r.items[1].options.length === 3)
  check('字母自动编排 A/B/C', r.items[1].options.map((o) => o.key).join('') === 'ABC')
  check('推荐标记读到', r.items[0].options[0].recommended === true)
  check('非推荐读到', r.items[0].options[1].recommended === false)
}

console.log('\n== 渲染 ==')
{
  const r = parseDecisionJson(JSON.stringify(SAMPLE))
  const out = formatDecision(r.items)
  const want = [
    '1. 问题1',
    '   A. 答案1（推荐）',
    '   B. 答案2',
    '2. 问题2',
    '   A. 答案1',
    '   B. 答案2（推荐）',
    '   C. 答案3',
  ].join('\n')
  check('形状与推荐标注都正确', out === want, JSON.stringify(out))
}

console.log('\n== 宽松接受 ==')
{
  ok('带 markdown 代码块', '```json\n' + JSON.stringify(SAMPLE) + '\n```')
  ok('JSON 前后有废话', '这是两个问题：\n' + JSON.stringify(SAMPLE) + '\n请选择')
  ok('JSON 压成一行', JSON.stringify(SAMPLE))
  ok('r 省略也能用', JSON.stringify([{ q: '问题', a: [{ t: '选项A' }, { t: '选项B' }] }]))
  ok('字符串里的方括号不干扰', JSON.stringify([{ q: '问题 [重要]', a: [{ t: '选[1]' }] }]))
}

console.log('\n== 拒绝 ==')
{
  bad('自由散文', '这两个问题都得改一下，你看怎么办？', '没找到 JSON')
  bad('空内容', '   ', '为空')
  bad('坏 JSON', '[{"q":"问题","a":}]', 'JSON 解析失败')
  bad('不是数组', '{"q":"问题","a":[]}', '最外层必须是数组')
  bad('空数组', '[]', '至少要有 1 个')
  bad('缺 q', '[{"a":[{"t":"x"}]}]', '缺少 q')
  bad('q 是空白', '[{"q":"   ","a":[{"t":"x"}]}]', '缺少 q')
  bad('缺 a', '[{"q":"问题"}]', 'a 必须是数组')
  bad('a 为空', '[{"q":"问题","a":[]}]', '没有任何选项')
  bad('缺 t', '[{"q":"问题","a":[{"r":true}]}]', '缺少 t')
  bad('t 是空白', '[{"q":"问题","a":[{"t":"  "}]}]', '缺少 t')
  bad('问题超过 5 个', JSON.stringify(
    Array.from({ length: 6 }, (_, i) => ({ q: `问题${i}`, a: [{ t: 'x' }] })),
  ), '最多 5 个')
  bad('选项超过 4 个', JSON.stringify([
    { q: '问题', a: [{ t: 'a' }, { t: 'b' }, { t: 'c' }, { t: 'd' }, { t: 'e' }] },
  ]), '最多 4 个')
}

console.log('\n== 上限常量 ==')
{
  check('问题上限 5', DECISION_LIMITS.MAX_ITEMS === 5)
  check('选项上限 4', DECISION_LIMITS.MAX_OPTIONS === 4)
}

console.log('\n== 示例本身可用 ==')
{
  // DECISION_JSON_EXAMPLE 会原样贴给 agent，它必须能被自己的解析器接受
  const r = parseDecisionJson(DECISION_JSON_EXAMPLE)
  check('示例能解析', r.ok, r.reason)
  check('示例有 2 个问题', r.ok && r.items.length === 2)
  check('示例含推荐项', r.ok && r.items.some((it) => it.options.some((o) => o.recommended)))
}

console.log('\n== 推荐项可为空、可多个 ==')
{
  const none = parseDecisionJson(JSON.stringify([{ q: 'q', a: [{ t: 'a' }, { t: 'b' }] }]))
  check('没有推荐也能过', none.ok)
  const many = parseDecisionJson(JSON.stringify([{ q: 'q', a: [{ t: 'a', r: true }, { t: 'b', r: true }] }]))
  check('多个推荐也能过', many.ok)
  check('渲染两个（推荐）', (formatDecision(many.items).match(/（推荐）/g) || []).length === 2)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
