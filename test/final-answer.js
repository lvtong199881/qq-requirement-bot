// 验证：等待确认时，agent 的最终答复会被发出；过程文字不会
import { parseGate } from '../src/protocol.js'

let pass = 0, fail = 0
const check = (n, c, e='') => { console.log(`  ${c?'✅':'❌'} ${n}${!c&&e?' — '+e:''}`); c?pass++:fail++ }

// 真实案例：agent 输出了 499 字含 A/B/C/D 选项，最后一行是 WAITING
const real = `测试阶段跑完了，核心路径全部通过。剩下两个缺陷需要你决定：

1）系统大字体没有生效（中）
- A（推荐）记为已知偏差，本需求不改
- B 本需求内就支持

2）启动图淡出时有约 1 帧和弹窗同屏（低）
- C（推荐）接受
- D 延后弹窗展示来避让

[[WAITING]]等你定这两项（回复「A、C」这种即可），我据此收口测试并进验收`

const gate = parseGate(real)
console.log('== parseGate ==')
check('状态为 waiting', gate.state === 'waiting')
check('label 提取到', gate.label.includes('等你定这两项'))
check('正文保留选项 A', gate.cleaned.includes('A（推荐）记为已知偏差'))
check('正文保留选项 C', gate.cleaned.includes('C（推荐）接受'))
check('正文去掉了 [[WAITING]] 标记', !gate.cleaned.includes('[[WAITING]]'))

console.log('\n== 发送决策 ==')
const finalAnswer = gate.state === 'waiting' || gate.state === 'done' ? (gate.cleaned || '').trim() : ''
check('waiting 时 finalAnswer 非空', finalAnswer.length > 100)
check('finalAnswer 含完整选项', finalAnswer.includes('A（推荐）') && finalAnswer.includes('C（推荐）'))

// 过程文字（不含标记的中间段落）不该被当最终答复
const mid = parseGate('我先读编排记录，看看进度。')
check('过程文字 state=running', mid.state === 'running')
check('过程文字不算 finalAnswer', !(mid.state === 'waiting' || mid.state === 'done'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
