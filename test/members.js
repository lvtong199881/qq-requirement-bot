/**
 * 群成员存储的单元测试。
 *
 * 这里只测存储本身；「没加入就看不见群」那条端到端在 test/app-api.js 里。
 * 重点在几个容易写错的地方：老群补群主、机器人自动管理员、重复加入不降级、
 * 群主/机器人不能改角色。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemberStore, MEMBER_ROLES } from '../src/store/members.js'

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'members-'))
const store = new MemberStore(join(tmp, 'members'))

const owner = { userId: 'u_owner', nickname: '阿宝', at: 1000 }
const bot = { id: 'u_bot', nickname: 'AI员工' }

console.log('\n== 初始化：群主 + 机器人 ==')
{
  const data = store.ensure('t1', { owner, bot })
  check('建出成员表', Boolean(data))
  check('群主记成 owner', store.roleOf('t1', 'u_owner') === MEMBER_ROLES.owner)
  check('ownerId 指向群主', data.ownerId === 'u_owner')
  check('机器人自动是管理员', store.roleOf('t1', 'u_bot') === MEMBER_ROLES.admin)
  check('机器人被标 isBot', store.list('t1').find((m) => m.userId === 'u_bot')?.isBot === true)
  check('人数是 2', store.count('t1') === 2, String(store.count('t1')))
  check('建群的人在群里', store.isMember('t1', 'u_owner') === true)
  check('不在群里的人不算成员', store.isMember('t1', 'u_stranger') === false)
}

console.log('\n== 幂等：重复 ensure 不重写文件 ==')
{
  const file = join(tmp, 'members', 'members-t1.json')
  const before = statSync(file).mtimeMs
  store.ensure('t1', { owner, bot })
  const after = statSync(file).mtimeMs
  check('内容没变就不落盘', before === after, `${before} → ${after}`)

  // 但少掉的机器人要补回来：删掉之后 ensure 应该再补一次
  const data = JSON.parse(readFileSync(file, 'utf8'))
  delete data.members.u_bot
  writeFileSync(file, JSON.stringify(data), 'utf8')
  const again = store.ensure('t1', { owner, bot })
  check('缺的机器人会被补回', again.members.u_bot?.role === MEMBER_ROLES.admin)
}

console.log('\n== 加人：重复加入不降级 ==')
{
  store.add('t1', { id: 'u_x', nickname: '小明' })
  check('能加人', store.isMember('t1', 'u_x') === true)
  check('默认是普通成员', store.roleOf('t1', 'u_x') === MEMBER_ROLES.member)

  store.setRole('t1', 'u_x', 'admin')
  store.add('t1', { id: 'u_x', nickname: '小明' })
  check('再加一次不会掉回普通成员', store.roleOf('t1', 'u_x') === 'admin', store.roleOf('t1', 'u_x'))
}

console.log('\n== 改角色：群主与机器人不能动 ==')
{
  const self = store.setRole('t1', 'u_owner', 'member')
  check('群主不能改自己的角色', self.ok === false && /群主/.test(self.error), self.error)

  const botRole = store.setRole('t1', 'u_bot', 'member')
  check('机器人不能改', botRole.ok === false && /机器人/.test(botRole.error), botRole.error)

  const ghost = store.setRole('t1', 'u_ghost', 'admin')
  check('不在群里的人改不了', ghost.ok === false && /不在群里/.test(ghost.error), ghost.error)

  const bad = store.setRole('t1', 'u_x', 'owner')
  check('不能把人直接设成群主', bad.ok === false, bad.error)
}

console.log('\n== 排序与退出 ==')
{
  // 群主第一，管理员其次，普通成员按加入时间
  store.add('t1', { id: 'u_y', nickname: '小红' })
  const roles = store.list('t1').map((m) => m.role)
  check('群主排第一', roles[0] === 'owner', JSON.stringify(roles))
  check('管理员在普通成员前面', roles.indexOf('admin') < roles.lastIndexOf('member'), JSON.stringify(roles))

  const leaveOwner = store.remove('t1', 'u_owner')
  check('群主不能退出', leaveOwner.ok === false && /群主/.test(leaveOwner.error), leaveOwner.error)

  const leave = store.remove('t1', 'u_x')
  check('普通成员能退出', leave.ok === true)
  check('退出后不算成员', store.isMember('t1', 'u_x') === false)
  check('退出不存在的成员失败', store.remove('t1', 'u_x').ok === false)
}

console.log('\n== 落盘文件与脏数据 ==')
{
  // threadId 来自 URL，不该让它拼出目录穿越的文件名
  store.ensure('../../evil name', { owner, bot })
  const names = readFileSync(join(tmp, 'members', 'members-.._.._evil_name.json'), 'utf8')
  check('非法字符被收敛成下划线', names.includes('u_owner'))

  const file = join(tmp, 'members', 'members-t_broken.json')
  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  check('坏文件当成没初始化', store.get('t_broken') === null)
  const rebuilt = store.ensure('t_broken', { owner, bot })
  check('坏文件能按群主重建', rebuilt?.ownerId === 'u_owner')

  writeFileSync(file, JSON.stringify({ members: { u_1: { role: '外星人', nickname: 5 } } }), 'utf8')
  const norm = store.get('t_broken')
  check('未知角色落成普通成员', norm.members.u_1.role === 'member', norm.members.u_1.role)
  check('昵称不是字符串就落成空串', norm.members.u_1.nickname === '', String(norm.members.u_1.nickname))
}

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
