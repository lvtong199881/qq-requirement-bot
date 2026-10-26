/**
 * 决策内容的格式约束：只接受「1. 标题 / A. 选项」结构。
 *   node test/decision.js
 */
import { parseDecision, formatDecision } from '../src/decision.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}
const ok = (name, text) => {
  const r = parseDecision(text)
  check(name, r.ok, r.reason)
  return r
}
const bad = (name, text, kw) => {
  const r = parseDecision(text)
  check(name, !r.ok && (!kw || r.reason.includes(kw)), r.ok ? '竟然通过' : r.reason)
}

console.log('\n== 标准格式 ==')
{
  const r = ok(
    '两项四选项',
    `1. 系统大字体没有生效（中）
   A. 记为已知偏差，本需求不改（推荐）
   B. 本需求内就支持
2. 启动图淡出约 1 帧重叠（低）
   A. 接受（推荐）
   B. 延后弹窗展示`,
  )
  check('事项数 2', r.items.length === 2)
  check('第一项 2 个选项', r.items[0].options.length === 2)
  check('选项键是 A/B', r.items[0].options.map((o) => o.key).join('') === 'AB')
  check('标题正确', r.items[0].title === '系统大字体没有生效（中）')
  check('末项 2 个选项', r.items[1].options.length === 2)
}

console.log('\n== 分隔符宽松、输出统一 ==')
{
  const variants = [
    ['全角点', '1．事项\n　A．选项\n　B．选项'],
    ['顿号', '1、事项\nA、选项\nB、选项'],
    ['右括号', '1) 事项\nA) 选项\nB) 选项'],
    ['无缩进', '1. 事项\nA. 选项\nB. 选项'],
    ['小写字母', '1. 事项\na. 选项\nb. 选项'],
  ]
  for (const [name, txt] of variants) {
    const r = parseDecision(txt)
    check(`${name} 能解析`, r.ok, r.reason)
    if (r.ok) {
      check(`${name} 输出统一`, formatDecision(r.items) === '1. 事项\n   A. 选项\n   B. 选项', formatDecision(r.items))
    }
  }
}

console.log('\n== 不合规一律拒绝 ==')
{
  bad('自由散文', '我觉得这两个问题都得改一下，你看怎么办？')
  bad('缺选项', '1. 大字体问题\n2. 启动图问题', '没有选项')
  bad('选项没有事项', 'A. 接受\nB. 不接受', '没有对应的事项')
  bad('混了散文行', '1. 问题\n   A. 选项\n\n以上是两个问题', '既不是')
  bad('空内容', '   ', '为空')
  bad('编号重复', '1. 甲\n   A. x\n1. 乙\n   A. y', '重复')
  bad('markdown 列表', '- 大字体问题\n- 启动图问题', '既不是')
  bad('纯问号', '要不要改？', '既不是')
}

console.log('\n== 输出格式 ==')
{
  const r = parseDecision('1. 甲\nA. 一\nB. 二\n2. 乙\nA. 三')
  const out = formatDecision(r.items)
  check('事项顶格', out.startsWith('1. 甲'))
  check('选项缩进 3 空格', out.includes('\n   A. 一'))
  check('多事项之间不空行', !out.includes('\n\n'), JSON.stringify(out))
  check('整体形状', out === '1. 甲\n   A. 一\n   B. 二\n2. 乙\n   A. 三', JSON.stringify(out))
}

console.log('\n== 单事项单选项也接受 ==')
{
  const r = ok('一个事项一个选项', '1. 只有一件事\n   A. 就这样')
  check('解析出 1 项', r.items.length === 1)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
