/**
 * 指令系统测试：解析与白名单。
 *
 * 收窄过一次范围：原先还测 /help、/release 确认、权限拒绝三套文案，
 * 但那些函数只被测试自己调用（flow-bridge 从来不 import），是纯死代码。
 * 留着测试等于给不存在的功能上保险——删掉函数时一并删掉。
 *
 *   node test/commands.js
 */
import { parseCommand, COMMANDS } from '../src/commands.js'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

console.log('\n== 解析 ==')
{
  check('非指令返回 null', parseCommand('首页加个弹窗') === null)
  check('空串返回 null', parseCommand('') === null)
  check('undefined 返回 null', parseCommand(undefined) === null)
  check('只有斜杠算未知指令', parseCommand('/').unknown === true)
  check('/stop 解析出名字', parseCommand('/stop').name === 'stop')
  check('大写也认', parseCommand('/STOP').name === 'stop')
  check('带前后空格', parseCommand('  /stop  ').name === 'stop')

  const withArg = parseCommand('/release 当前需求')
  check('参数被切出来', withArg.arg === '当前需求')
  check('参数不进名字', withArg.name === 'release')

  const unknown = parseCommand('/whatever')
  check('未知指令标 unknown', unknown.unknown === true)
  check('未知指令没有 def', unknown.def === null)

  const known = parseCommand('/help')
  check('已知指令带 def', known.def === COMMANDS.help)
  check('已知指令不算 unknown', known.unknown === false)
}

console.log('\n== 指令表 ==')
{
  check('/help 是 user 级', COMMANDS.help.scope === 'user')
  check('/resume 是 user 级', COMMANDS.resume.scope === 'user')
  check('/stop 是 user 级', COMMANDS.stop.scope === 'user')
  check('/release 是 admin 级', COMMANDS.release.scope === 'admin')
  check('每条都有 desc', Object.values(COMMANDS).every((c) => typeof c.desc === 'string' && c.desc))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
