/**
 * Prompt 模板：渲染、校验、配置读写。
 *   node test/prompt.js
 */
import {
  DEFAULT_PROMPT_TEMPLATE,
  validatePromptTemplate,
  gateInstructions,
  PROMPT_VARS,
} from '../src/prompt.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

console.log('\n== 默认模板渲染 ==')
{
  const t = gateInstructions({ botName: '产品同学', approval: 'manual' })
  check('替换 {{botName}}', t.includes('@产品同学') && !t.includes('{{botName}}'))
  check('替换 {{approval}}', t.includes('【本群为手动批准模式】') && !t.includes('{{approval}}'))
  check('不含遗留占位符', !/\{\{\w+\}\}/.test(t))
  check('含 [[WAITING]] 用法', t.includes('[[WAITING]]'))
  check('含 [[DONE]] 用法', t.includes('[[DONE]]'))
  check('含 [[ASK]] 用法', t.includes('[[ASK]]'))
  check('手动模式要求每阶段停下', t.includes('等用户回复「通过」'))

  const auto = gateInstructions({ botName: '产品同学', approval: 'auto' })
  check('自动模式措辞不同', auto.includes('【本群为自动推进模式】'))
  check('自动模式不要求每阶段停', !auto.includes('每个阶段产物完成后都要'))
  check('两种模式标题都不重复', (t.match(/【本群为/g) || []).length === 1 && (auto.match(/【本群为/g) || []).length === 1)
}

console.log('\n== 自定义模板 ==')
{
  const custom = '自定义开头 @{{botName}}\n[[WAITING]]停下\n[[DONE]]完成\n{{approval}}'
  const t = gateInstructions({ botName: '小助手', approval: 'manual', template: custom })
  check('用自定义模板', t.startsWith('自定义开头 @小助手'))
  check('自定义也替换 approval', t.includes('手动批准模式'))
  check('不使用默认内容', !t.includes('【你是谁】'))
}

console.log('\n== 校验 ==')
{
  const bad = (name, input, keyword) => {
    const r = validatePromptTemplate(input)
    check(name, !r.ok && (!keyword || r.error.includes(keyword)), r.ok ? '竟然通过了' : r.error)
  }
  const good = (name, input) => {
    const r = validatePromptTemplate(input)
    check(name, r.ok, r.error)
  }

  bad('空字符串', '')
  bad('null', null)
  bad('纯空白', '   \n  ')
  bad('缺 [[WAITING]]', '只有 [[DONE]]', 'WAITING')
  bad('缺 [[DONE]]', '只有 [[WAITING]]', 'DONE')
  bad('未知占位符', '[[WAITING]] [[DONE]] {{whoami}}', 'whoami')
  bad('过长', '[[WAITING]] [[DONE]]' + 'x'.repeat(20001), '太长')

  good('最小合法', '[[WAITING]] [[DONE]]')
  good('带占位符', '[[WAITING]] [[DONE]] @{{botName}} {{approval}}')
  good('默认模板本身', DEFAULT_PROMPT_TEMPLATE)
}

console.log('\n== 占位符清单 ==')
{
  check('声明了 botName', 'botName' in PROMPT_VARS)
  check('声明了 approval', 'approval' in PROMPT_VARS)
  check('只有两个', Object.keys(PROMPT_VARS).length === 2)
}

console.log('\n== 配置开关 ==')
{
  // template 为空时回退默认
  const fallback = gateInstructions({ botName: 'X', approval: 'manual', template: '' })
  check('空模板回退默认', fallback.includes('【你是谁】'))
  const nul = gateInstructions({ botName: 'X', approval: 'manual', template: null })
  check('null 回退默认', nul.includes('【你是谁】'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
