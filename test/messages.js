/**
 * 群消息文案模板：渲染、校验、自定义覆盖。
 *   node test/messages.js
 */
import {
  MESSAGE_TEMPLATES,
  MESSAGE_VARS,
  renderMessage,
  validateMessageTemplate,
  validateAllMessages,
} from '../src/messages.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

console.log('\n== 四类消息都在 ==')
{
  check('回执 ack', !!MESSAGE_TEMPLATES.ack)
  check('阶段已开始', !!MESSAGE_TEMPLATES.stageStart)
  check('阶段已完成', !!MESSAGE_TEMPLATES.stageDone)
  check('阶段推进', !!MESSAGE_TEMPLATES.stageAdvance)
  check('心跳', !!MESSAGE_TEMPLATES.heartbeat)
  check('异常', !!MESSAGE_TEMPLATES.abnormal)
  check('需要决策', !!MESSAGE_TEMPLATES.decision)
  check('打回追问', !!MESSAGE_TEMPLATES.rejectAsk)
  check('空消息引导', !!MESSAGE_TEMPLATES.idleHint)
  check('需求完成', !!MESSAGE_TEMPLATES.done)
  check('每条都有分组和标签', Object.values(MESSAGE_TEMPLATES).every((t) => t.group && t.label && t.template))
  check('每条都声明了可用变量', Object.values(MESSAGE_TEMPLATES).every((t) => Array.isArray(t.vars)))
}

console.log('\n== 指令与操作反馈 ==')
{
  check('未知指令', renderMessage('unknownCmd', { cmd: 'nope' }).includes('/nope'))
  check('无权限', renderMessage('denied', { cmd: 'stop' }).includes('/stop'))
  check('停止完成', renderMessage('stopDone', {}) === '已停止当前任务。')
  check('停止无任务', renderMessage('stopNone', {}) === '当前没有在跑的任务。')
  check('打断完成', renderMessage('interruptDone', {}) === '已打断当前回合。')
  check('打断无回合', renderMessage('interruptNone', {}) === '当前没有在跑的回合。')
  check('取消释放', renderMessage('releaseCancel', {}) === '已取消释放。')
  check('取消打回', renderMessage('rejectCancel', {}) === '已取消打回，阶段保持原样。')
  check('清空绑定', renderMessage('cleared', {}).includes('下一条消息发新需求'))
  check('dry-run', renderMessage('dryRun', {}).includes('[dry-run]'))

  const rel = renderMessage('releaseAsk', { target: '「demo」', stage: '开发' })
  check('释放确认带需求名', rel.includes('「demo」'))
  check('释放确认带阶段', rel.includes('「开发」'))
  check('释放确认说明三件事', rel.includes('会做三件事'))

  const help = renderMessage('help', {
    list: '/help  看说明',
    statusLine: '\n\n当前状态：开发中',
    permissionNote: '只有群主能用。',
  })
  check('帮助含指令列表', help.includes('/help  看说明'))
  check('帮助含状态行', help.includes('当前状态：开发中'))
  check('帮助含权限说明', help.includes('只有群主能用。'))
}

console.log('\n== 系统通知 ==')
{
  check('会话重置', renderMessage('sessionReset', {}).includes('重新开始这一轮'))
  check('重启通知', renderMessage('restartNotice', {}).includes('bridge 正在重启'))
}

console.log('\n== 没看懂用户说话 ==')
{
  const r = renderMessage('ambiguous', { waitingLabel: '等你确认配色' })
  check('带上等待事项', r.includes('等你确认配色'))
  check('问用户是不是答别的', r.includes('还是别的意思'))
}

console.log('\n== 默认渲染 ==')
{
  const ack = renderMessage('ack', { stage: '开发', duration: '1小时2分钟' })
  check('回执', ack === '当前开发阶段中，已进行 1小时2分钟。', ack)

  const hb = renderMessage('heartbeat', { stage: '测试', duration: '30秒' })
  check('心跳', hb === '当前测试阶段中，已进行 30秒。', hb)

  const start = renderMessage('stageStart', { stage: '设计' })
  check('阶段已开始', start === '设计阶段已开始。', start)

  const done = renderMessage('stageDone', { stage: '设计' })
  check('阶段已完成', done === '设计阶段已完成。', done)

  const adv = renderMessage('stageAdvance', { stageDone: '测试', stageStarted: '验收' })
  check('阶段推进合成一句', adv === '测试阶段已完成，验收阶段已开始。', adv)

  const ab = renderMessage('abnormal', { stage: '测试', reason: '进程退出码 1' })
  check('异常带原因', ab.includes('测试阶段异常') && ab.includes('进程退出码 1'))

  const dec = renderMessage('decision', { content: '1）大字体\n- A 不改\n- B 改' })
  check('决策换行排版', dec === '需要决策：\n1）大字体\n- A 不改\n- B 改', JSON.stringify(dec))
}

console.log('\n== 自定义覆盖 ==')
{
  const custom = { ack: '⏳ {{stage}} 进行中（{{duration}}）' }
  check('用自定义', renderMessage('ack', { stage: '开发', duration: '5分钟' }, custom) === '⏳ 开发 进行中（5分钟）')
  check('其他不受影响', renderMessage('heartbeat', { stage: '开发', duration: '5分钟' }, custom).includes('当前开发阶段中'))
}

console.log('\n== 未知变量渲染为空 ==')
{
  // 模板里引用了没传的变量，渲染成空串而不是留着 {{x}}
  const out = renderMessage('ack', { stage: '开发' })
  check('缺 duration 渲染为空', out === '当前开发阶段中，已进行 。', JSON.stringify(out))
  check('不残留占位符', !/\{\{/.test(out))
}

console.log('\n== 校验 ==')
{
  const bad = (name, key, input, kw) => {
    const r = validateMessageTemplate(key, input)
    check(name, !r.ok && (!kw || r.error.includes(kw)), r.ok ? '竟然通过' : r.error)
  }
  const good = (name, key, input) => {
    const r = validateMessageTemplate(key, input)
    check(name, r.ok, r.error)
  }

  bad('空模板', 'ack', '')
  bad('纯空白', 'ack', '   ')
  bad('null', 'ack', null)
  bad('未知占位符', 'ack', '{{bogus}}', 'bogus')
  bad('未知 key', 'nope', '随便', '未知文案')
  bad('过长', 'ack', 'x'.repeat(2001), '太长')

  good('最小合法', 'ack', '进行中')
  good('用允许的变量', 'ack', '{{stage}} {{duration}}')
  good('默认模板本身', 'ack', MESSAGE_TEMPLATES.ack.template)
}

console.log('\n== 批量校验 ==')
{
  check('全部合法', validateAllMessages({ ack: 'a', heartbeat: 'b' }).ok)
  const bad = validateAllMessages({ ack: 'a', heartbeat: '{{bad}}' })
  check('一条非法整体拒绝', !bad.ok && bad.error.includes('心跳'), bad.error)
  check('非对象拒绝', !validateAllMessages('nope').ok)
}

console.log('\n== 变量清单完整 ==')
{
  const declared = Object.keys(MESSAGE_VARS)
  const used = new Set()
  for (const t of Object.values(MESSAGE_TEMPLATES)) {
    for (const m of t.template.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1])
  }
  const missing = [...used].filter((v) => !declared.includes(v))
  check('模板用到的变量都已声明', missing.length === 0, missing.join(', '))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
