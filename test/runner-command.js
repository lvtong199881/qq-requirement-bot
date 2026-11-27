/**
 * Windows 下 spawn 命令串的拼法：裸命令名 dsh 不能加引号（否则 cmd 把它当
 * 相对路径解析，落到 DeepSeek Harness.exe 报「不是内部或外部命令」）；
 * 带空格的绝对路径必须加引号；参数含空白要加引号。
 *   node test/runner-command.js
 */
import { buildWinCommand } from '../src/runner.js'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const a = buildWinCommand('dsh', ['--profile', 'qqbot', '--json', '-'])
check('裸命令名 dsh 不加引号', a === 'dsh --profile qqbot --json -', a)

const b = buildWinCommand('C:\\Program Files\\DeepSeek Harness\\dsh.cmd', ['--json'])
check('带空格的绝对路径加引号', b === '"C:\\Program Files\\DeepSeek Harness\\dsh.cmd" --json', b)

const c = buildWinCommand('C:\\bin\\dsh.cmd', ['--approval-policy', 'never'])
check('无空格绝对路径也加引号（含分隔符）', c.startsWith('"C:\\bin\\dsh.cmd"'), c)

const d = buildWinCommand('dsh', ['--session-id', 'a b'])
check('含空白的参数加引号', d === 'dsh --session-id "a b"', d)

// --permission-mode 透传：dev 回合要派生构建子进程，参数必须真的进命令行
const e = buildWinCommand('dsh', ['--permission-mode', 'danger-full-access', '--json'])
check('permission-mode 参数原样拼接', e === 'dsh --permission-mode danger-full-access --json', e)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
