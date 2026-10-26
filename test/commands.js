/**
 * 指令系统测试：解析、白名单、帮助文案、release 确认。
 *   node test/commands.js
 */
import { parseCommand, helpText, releaseConfirmText, deniedText, COMMANDS } from '../src/commands.js'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

console.log('\n== 指令解析 ==')
{
  check('非指令返回 null', parseCommand('继续') === null)
  check('空消息返回 null', parseCommand('') === null)

  const help = parseCommand('/help')
  check('/help 命中', help?.name === 'help' && !help.unknown)

  const resume = parseCommand('/resume')
  check('/resume 命中', resume?.name === 'resume')

  const stop = parseCommand('/stop')
  check('/stop 命中', stop?.name === 'stop')

  const rel = parseCommand('/release')
  check('/release 命中', rel?.name === 'release')
  check('/release 需要二次确认', rel?.def?.confirm === true)

  const upper = parseCommand('/HELP')
  check('大小写不敏感', upper?.name === 'help')

  const withArg = parseCommand('/release  confirm')
  check('参数被解析', withArg?.arg === 'confirm')

  const unknown = parseCommand('/nope')
  check('未知指令标记 unknown', unknown?.unknown === true)
}

console.log('\n== 白名单 ==')
{
  check('/help 是 user 级', COMMANDS.help.scope === 'user')
  check('/resume 是 user 级', COMMANDS.resume.scope === 'user')
  check('/stop 是 user 级', COMMANDS.stop.scope === 'user')
  check('/release 是 admin 级', COMMANDS.release.scope === 'admin')
}

console.log('\n== 帮助文案 ==')
{
  const forUser = helpText({ isAdmin: false, statusLine: '当前状态：开发阶段中。' })
  check('列出 /help', forUser.includes('/help'))
  check('列出 /resume', forUser.includes('/resume'))
  check('列出 /stop', forUser.includes('/stop'))
  check('列出 /release', forUser.includes('/release'))
  check('标注管理员指令', forUser.includes('（管理员）'))
  check('说明权限模型', forUser.includes('只有群主、群管理员'))
  check('带当前状态', forUser.includes('当前状态：开发阶段中。'))
}

console.log('\n== release 确认 ==')
{
  const text = releaseConfirmText({ reqId: 'welcome-dialog', stage: '开发' })
  check('写明需求名', text.includes('welcome-dialog'))
  check('写明阶段', text.includes('开发'))
  check('说明会打断回合', text.includes('打断'))
  check('说明会清空会话', text.includes('清空'))
  check('要求回复确认', text.includes('回复「确认」'))
}

console.log('\n== 权限拒绝文案 ==')
{
  const d = deniedText('release')
  check('说明需要群主权限', d.includes('需要群主权限'))
  check('点明群管理员不能执行', d.includes('群管理员不能执行'))
  check('带上指令名', d.includes('/release'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
