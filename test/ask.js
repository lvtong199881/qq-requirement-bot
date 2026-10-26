/**
 * [[ASK]] 标记：需要用户拍板的具体内容单独承载，bridge 负责拼接。
 *   node test/ask.js
 */
import { parseGate } from '../src/protocol.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

console.log('\n== 标准格式：WAITING + ASK ==')
{
  const text = `测试阶段跑完了，核心路径全部通过。

[[WAITING]]等你定这两项
[[ASK]]
1）系统大字体没有生效（中）
- A（推荐）记为已知偏差
- B 本需求内就支持

2）启动图淡出约 1 帧重叠（低）
- C（推荐）接受
- D 延后弹窗展示`

  const g = parseGate(text)
  check('state=waiting', g.state === 'waiting')
  check('label 只留一句话', g.label === '等你定这两项')
  check('ask 提取到内容', g.ask.includes('系统大字体没有生效'))
  check('ask 含选项 A', g.ask.includes('A（推荐）'))
  check('ask 含选项 C', g.ask.includes('C（推荐）'))
  check('ask 不含标记本身', !g.ask.includes('[[ASK]]'))
  check('cleaned 不含标记', !g.cleaned.includes('[[WAITING]]') && !g.cleaned.includes('[[ASK]]'))
  check('cleaned 去掉 ask 段', !g.cleaned.includes('系统大字体'))
}

console.log('\n== ASK 写在同一行 ==')
{
  const g = parseGate('[[WAITING]]等你确认\n[[ASK]]要不要把按钮改成蓝色？')
  check('同一行也能解析', g.ask === '要不要把按钮改成蓝色？', g.ask)
}

console.log('\n== 只有 WAITING，没有 ASK（旧格式）==')
{
  const g = parseGate('阶段完成了。\n[[WAITING]]等你确认')
  check('state=waiting', g.state === 'waiting')
  check('ask 为空', g.ask === '')
  check('cleaned 保留正文', g.cleaned.includes('阶段完成了'))
}

console.log('\n== ASK 后面还有内容（应止于下一个标记）==')
{
  const g = parseGate('[[WAITING]]等你定\n[[ASK]]选 A 还是 B\n\n[[DONE]]收工')
  check('ask 只取到下一个标记前', g.ask === '选 A 还是 B', JSON.stringify(g.ask))
}

console.log('\n== 过程文字不受影响 ==')
{
  const g = parseGate('我先读编排记录，看看进度。')
  check('state=running', g.state === 'running')
  check('ask 为空', g.ask === '')
}

console.log('\n== bridge 拼接 ==')
{
  const g = parseGate('阶段完成。\n[[WAITING]]等你定这两项\n[[ASK]]\n- A\n- B')
  const finalAnswer = g.ask.trim() || g.cleaned.trim()
  check('优先用 ask', finalAnswer === '- A\n- B', JSON.stringify(finalAnswer))

  const g2 = parseGate('阶段完成，请确认。\n[[WAITING]]等你确认')
  const fa2 = g2.ask.trim() || g2.cleaned.trim()
  check('无 ask 时回退整段答复', fa2.includes('阶段完成，请确认'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
