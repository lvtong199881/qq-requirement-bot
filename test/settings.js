/**
 * 设置页的输入解析：白名单分隔、校验、边界。
 *   node test/settings.js
 */
import { parseAdminUsers } from '../src/ui/panel.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n      得到: ${JSON.stringify(got)}\n      期望: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

console.log('\n== 空值 ==')
eq('null → 空列表', parseAdminUsers(null), { ok: true, list: [] })
eq('undefined → 空列表', parseAdminUsers(undefined), { ok: true, list: [] })
eq('空字符串 → 空列表', parseAdminUsers(''), { ok: true, list: [] })
eq('纯空格 → 空列表', parseAdminUsers('   '), { ok: true, list: [] })
eq('只有逗号 → 空列表', parseAdminUsers(',,,'), { ok: true, list: [] })

console.log('\n== 分隔符 ==')
eq('英文逗号', parseAdminUsers('111111,123456789'), { ok: true, list: ['111111', '123456789'] })
eq('中文逗号', parseAdminUsers('111111，123456789'), { ok: true, list: ['111111', '123456789'] })
eq('混合 + 空格', parseAdminUsers('111111, 123456789， 987654321'), { ok: true, list: ['111111', '123456789', '987654321'] })
eq('换行', parseAdminUsers('111111\n123456789'), { ok: true, list: ['111111', '123456789'] })
eq('制表符', parseAdminUsers('111111\t123456789'), { ok: true, list: ['111111', '123456789'] })
eq('重复项去重', parseAdminUsers('111111,111111'), { ok: true, list: ['111111'] })
eq('数字类型也接受', parseAdminUsers(123456789), { ok: true, list: ['123456789'] })

console.log('\n== 非法输入 ==')
{
  const r1 = parseAdminUsers('abc')
  eq('非数字被拒', r1.ok, false)
  eq('错误信息点名非法值', r1.error.includes('abc'), true)

  const r2 = parseAdminUsers('111111,abc')
  eq('部分非法整批拒绝', r2.ok, false)

  eq('含字母被拒', parseAdminUsers('12345abc').ok, false)
  eq('3 位太短被拒', parseAdminUsers('123').ok, false)
  eq('13 位太长被拒', parseAdminUsers('1234567890123').ok, false)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
