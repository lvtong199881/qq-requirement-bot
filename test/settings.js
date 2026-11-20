/**
 * 文案模板：渲染、校验、自定义覆盖。
 *
 * 注意 test/messages.js 测的是模板引擎本身，不是「发了什么消息」。
 * 模板表里仍留着不少 QQ 群时代的条目（ack* / groupTaken / releaseAsk 等），
 * 它们现在没有调用方了，但没删——面板的设置页允许用户改文案，
 * 删 key 会让已存的覆盖配置对不上。等确认没人用过这些覆盖再清理。
 *
 *   node test/settings.js
 */
import { renderMessage, MESSAGE_TEMPLATES, validateMessageTemplate } from '../src/ui/messages.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n      得到: ${JSON.stringify(got)}\n      期望: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

console.log('\n== 编排用到的模板都在 ==')
{
  const used = [
    'v2Kickoff', 'v2StageStart', 'v2StageDone', 'v2Artifact',
    'v2Waiting', 'v2Confirm', 'v2Blocked', 'v2Done', 'v2Queued',
    'heartbeat', 'abnormal',
  ]
  for (const key of used) {
    check(key, Boolean(MESSAGE_TEMPLATES[key]))
  }
}

console.log('\n== 渲染：变量替换 ==')
{
  eq(
    '单变量',
    renderMessage('v2StageStart', { stage: '开发' }, {}),
    '当前「开发」阶段中。',
  )
  eq(
    '多变量',
    renderMessage('v2Confirm', { stage: '开发', next: '测试' }, {}),
    '「开发」已完成，回复「通过」进入下一步（测试），回「打回」重做这一步。',
  )
  check(
    '换行的模板保留换行',
    renderMessage('v2Waiting', { content: '配色\n字体' }, {}).includes('\n'),
  )
}

console.log('\n== 渲染：缺变量不残留占位符 ==')
{
  const out = renderMessage('v2Kickoff', {}, {})
  check('不残留 {{', !/\{\{/.test(out), out)
}

console.log('\n== 渲染：自定义覆盖 ==')
{
  eq(
    '覆盖生效',
    renderMessage('v2StageStart', { stage: '测试' }, { v2StageStart: '现在跑 {{stage}}' }),
    '现在跑 测试',
  )
  eq(
    '没覆盖的走默认',
    renderMessage('v2Done', { name: '深色模式' }, { v2StageStart: '现在跑 {{stage}}' }),
    '「深色模式」全部完成。',
  )
  eq(
    '覆盖传空串仍用默认',
    renderMessage('v2Done', { name: 'X' }, { v2Done: '' }),
    '「X」全部完成。',
  )
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

  bad('空模板', 'v2Kickoff', '')
  bad('纯空白', 'v2Kickoff', '   ')
  bad('null', 'v2Kickoff', null)
  bad('未知占位符', 'v2Kickoff', '{{bogus}}', 'bogus')
  bad('未知 key', 'nope', '随便', '未知文案')
  bad('过长', 'v2Kickoff', 'x'.repeat(2001), '太长')

  good('最小合法', 'v2Kickoff', '收到')
  good('用允许的变量', 'v2Kickoff', '收到 {{name}}')
  good('默认模板本身', 'v2Kickoff', MESSAGE_TEMPLATES.v2Kickoff.template)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
