/**
 * 防走偏测试：验证 router 的分类、绑定、锚点、骨架生成。
 *
 *   node test/router.js
 */
import { classifyMessage, isAmbiguous, anchorBlock, routedPrompt, ambiguousReply, INTENT } from '../src/router.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

console.log('\n== 意图分类 ==')
{
  const cases = [
    ['通过', INTENT.APPROVE],
    ['通过', INTENT.APPROVE],
    ['ok', INTENT.APPROVE],
    ['好的。', INTENT.APPROVE],
    ['LGTM', INTENT.APPROVE],
    ['打回', INTENT.REJECT],
    ['继续', INTENT.CONTINUE],
    ['接着跑', INTENT.CONTINUE],
    ['停', INTENT.STOP],
    ['停止', INTENT.STOP],
    ['新需求', INTENT.NEW_REQ],
    ['新需求 首页加弹窗', INTENT.NEW_REQ],
    ['重开', INTENT.NEW_REQ],
    ['帮助', INTENT.HELP],
    ['本群', INTENT.INFO],
    ['首页加个欢迎弹窗，手动批准', INTENT.CONTENT],
    ['Q-1 选 A，Q-2 选 A，Q-3 选 B，Q-4 选 A', INTENT.CONTENT],
  ]
  for (const [text, expect] of cases) {
    const r = classifyMessage(text)
    check(`「${text}」→ ${expect}`, r.intent === expect, `实际 ${r.intent}`)
  }
  const nr = classifyMessage('新需求 首页加弹窗')
  check('新需求带描述时 detail 提取', nr.detail === '首页加弹窗')

  check('光说打回时 detail 为空', classifyMessage('打回').detail === '')
  check('打回带意见时提取意见', classifyMessage('打回 主按钮改成蓝色').detail === '主按钮改成蓝色')
  check('打回带逗号也提取', classifyMessage('打回，文案太长了').detail === '文案太长了')
}

console.log('\n== 含糊判定 ==')
{
  const waitingState = { waitingLabel: '请回复 Q-1～Q-4 的选择' }
  check('短含糊消息 + 有等待 → 反问', isAmbiguous('AAAA', waitingState) === true)
  check('短含糊消息 + 无等待 → 不反问', isAmbiguous('AAAA', null) === false)
  check('长消息 → 不反问', isAmbiguous('首页加一个欢迎弹窗，关闭方式包括back', waitingState) === false)
  check('已识别意图 → 不反问', isAmbiguous('通过', waitingState) === false)
  const r = ambiguousReply(waitingState.waitingLabel)
  check('反问文案包含等待事项', r.includes('Q-1'))
}

console.log('\n== 锚点生成 ==')
{
  const a = anchorBlock({ reqId: 'welcome-dialog', projectDir: '/p', stage: '2 设计' })
  check('锚点含需求标识', a.includes('welcome-dialog'))
  check('锚点含编排记录路径', a.includes('docs/requirements/welcome-dialog/编排记录.md'))
  check('锚点含当前阶段', a.includes('2 设计'))
  check('锚点含禁止越界声明', a.includes('禁止') && a.includes('其他需求'))
}

console.log('\n== 路由骨架 ==')
{
  const bind = { reqId: 'welcome-dialog', stage: '2 设计', waitingLabel: '请回复 Q-1～Q-4 的选择' }

  const ap = routedPrompt({ intent: INTENT.APPROVE, userText: '通过', bind })
  check('批准骨架锁定需求', ap.includes('welcome-dialog'))
  check('批准骨架指明阶段', ap.includes('2 设计'))

  const rj = routedPrompt({ intent: INTENT.REJECT, userText: '文案不行重写', bind })
  check('打回骨架带用户原话', rj.includes('文案不行重写'))
  check('打回骨架不自己改产物', rj.includes('不要自己动手改'))

  // 打回时把「修改意见」独立带进去，agent 才知道要改什么
  const rj2 = routedPrompt({
    intent: INTENT.REJECT,
    userText: '打回',
    bind: { ...bind, rejectReason: '主按钮改成蓝色' },
  })
  check('打回骨架带上修改意见', rj2.includes('主按钮改成蓝色'), rj2)
  check('打回骨架说明用户要改什么', rj2.includes('用户要改的是'))

  const ct = routedPrompt({ intent: INTENT.CONTINUE, userText: '继续', bind })
  check('继续骨架指向编排记录', ct.includes('编排记录'))

  // 含糊回复在 waiting 上下文中 → 当成对等待事项的回应
  const amb = routedPrompt({ intent: INTENT.CONTENT, userText: 'AAAA', bind })
  check('等待中的内容消息带上等待事项', amb.includes('Q-1～Q-4'))
  check('内容消息带原文', amb.includes('AAAA'))

  // 无等待时内容消息原样透传
  const raw = routedPrompt({ intent: INTENT.CONTENT, userText: '首页加弹窗', bind: { reqId: null, stage: null, waitingLabel: '' } })
  check('无等待时内容原样透传', raw === '首页加弹窗')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
