/**
 * 账号体系：预设管理员 + 用户表生命周期。
 *
 * 预设账号是唯一一处「系统自己建账号」的地方，做错的代价有两头：
 * 建多了等于后门，建晚了新装机没人能进。所以这里钉死三件事：
 *   1. 只在空表时创建，改过密码/加过账号后重启不能又冒出来
 *   2. 表非空但没有管理员时不自动补 admin（那是后门，不是便利）
 *   3. 预设账号就是普通 admin，能被降级、能改密码，没有特殊豁免
 *   node test/account.js
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore, ROLES, publicUser, BOT_USER_ID } from '../src/account/store.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const dir = mkdtempSync(join(tmpdir(), 'qq-account-'))
const fresh = () => join(dir, `s${Math.random().toString(36).slice(2, 8)}`)

console.log('\n== 空表：创建预设管理员 ==')
{
  const d = fresh()
  const users = new UserStore(d)
  check('一开始没有管理员', users.needsFirstAdmin())
  check('一开始没账号', users.list().length === 0)

  const r = users.ensureBootstrap()
  check('创建成功', r.created === true)
  check('用户名是 admin', r.user.username === 'admin')
  check('角色是管理员', r.user.role === ROLES.admin)
  check('昵称是「管理员」', r.user.nickname === '管理员')
  check('带了预设标记', r.user.preset === true)
  check('对外不暴露哈希', r.user.passwordHash === undefined && r.user.salt === undefined)
  check('不再需要首个管理员', users.needsFirstAdmin() === false)

  // 真的能登进来，而且默认密码就是承诺的那个
  const login = users.login({ username: 'admin', password: '123456' })
  check('默认密码能登录', login.ok === true && login.user.username === 'admin')
  check('错密码登不进', users.login({ username: 'admin', password: '123457' }).ok === false)

  const again = users.ensureBootstrap()
  check('再调一次不重复建', again.created === false && users.list().length === 1)
}

console.log('\n== 重启：表非空就不该再建 ==')
{
  const d = fresh()
  new UserStore(d).ensureBootstrap()
  // 改掉密码，模拟「用户按提示换过了」
  const first = new UserStore(d)
  const id = first.findByUsername('admin').id
  check('改密码成功', first.resetPassword(id, 'my-own-pass').ok === true)
  // 先把另一个人提成管理员，否则「唯一管理员不能降级」会挡住下面这步
  first.register({ username: '阿宝', password: 'pass1234' })
  first.setRole(first.findByUsername('阿宝').id, ROLES.admin)
  first.setRole(id, ROLES.member)
  check('预设账号降级后不再是管理员', new UserStore(d).findByUsername('admin').role === ROLES.member)
  check('别人顶上了管理员', new UserStore(d).needsFirstAdmin() === false)

  const restarted = new UserStore(d)
  const r = restarted.ensureBootstrap()
  check('重启不重建预设账号', r.created === false && restarted.list().length === 2)
  check('原来那个账号还在', restarted.findByUsername('admin') !== null)
  check('角色没被偷偷改回 admin', restarted.findByUsername('admin').role === ROLES.member)
  check('改过的密码还能用', restarted.login({ username: 'admin', password: 'my-own-pass' }).ok === true)
  check('默认密码已失效', restarted.login({ username: 'admin', password: '123456' }).ok === false)
}

console.log('\n== 表非空但没有管理员：不补 admin（那是后门）==')
{
  // 正常操作走不到这个状态（setRole / setDisabled 都拦着「最后一个管理员」），
  // 但手工编辑 users.json、或者从更早的版本迁过来都可能留下它。
  // 这时候自动建个 admin/123456 等于给所有人留了把万能钥匙——
  // 只能提示用户怎么救，不能替他把门打开。
  const d = fresh()
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'users.json'),
    JSON.stringify({
      users: [
        {
          id: 'u_manual',
          username: '阿宝',
          nickname: '产品阿宝',
          role: 'member',
          salt: 'aabbccdd',
          passwordHash: '00'.repeat(64),
          createdAt: 1,
          disabled: false,
        },
      ],
    }),
  )
  const users = new UserStore(d)
  check('读出了那个 member', users.findByUsername('阿宝')?.role === ROLES.member)
  check('确实没有管理员', users.needsFirstAdmin() === true)

  const r = users.ensureBootstrap()
  check('不建预设账号', r.created === false)
  check('没有凭空出现的 admin', users.findByUsername('admin') === null)
  check('账号数没变', users.list().length === 1)
}

console.log('\n== 已经有别人注册过：不建预设 ==')
{
  const d = fresh()
  const users = new UserStore(d)
  const reg = users.register({ username: '阿宝', password: 'pass1234', nickname: '产品阿宝' })
  check('第一个注册者仍是管理员', reg.ok === true && reg.user.role === ROLES.admin)

  const r = users.ensureBootstrap()
  check('不建预设（表非空）', r.created === false)
  check('只有一个人', users.list().length === 1)
  check('没有凭空出现的 admin', users.findByUsername('admin') === null)
}

console.log('\n== 预设账号没有特权 ==')
{
  const d = fresh()
  const users = new UserStore(d)
  users.ensureBootstrap()
  const target = users.findByUsername('admin')
  // 备一个第二管理员：预设账号没有豁免，但它照样不能让「最后一个管理员」消失
  users.register({ username: '阿宝', password: 'pass1234' })
  users.setRole(users.findByUsername('阿宝').id, ROLES.admin)

  check('能被降级', users.setRole(target.id, ROLES.member).ok === true)
  check('降级后角色真的变了', users.findById(target.id).role === ROLES.member)

  // 只剩它一个 admin 时不能降级/停用，这条对预设账号同样成立
  const d2 = fresh()
  const u2 = new UserStore(d2)
  u2.ensureBootstrap()
  const only = u2.findByUsername('admin')
  const demote = u2.setRole(only.id, ROLES.member)
  check('唯一管理员不能降级', demote.ok === false && demote.error.includes('最后一个管理员'))
  const disable = u2.setDisabled(only.id, true)
  check('唯一管理员不能停用', disable.ok === false && disable.error.includes('最后一个管理员'))
}

console.log('\n== 自定义预设参数 ==')
{
  const d = fresh()
  const users = new UserStore(d)
  const r = users.ensureBootstrap({ username: 'boss', password: 'boss123', nickname: '老板' })
  check('能用自定义用户名', r.user.username === 'boss')
  check('自定义密码生效', users.login({ username: 'boss', password: 'boss123' }).ok === true)
  check('自定义昵称生效', r.user.nickname === '老板')
}

console.log('\n== 改过密码就不再提示初始密码 ==')
{
  const d = fresh()
  const users = new UserStore(d)
  users.ensureBootstrap()
  const p1 = users.pendingPresetAdmin()
  check('刚建好时提示 admin', p1?.username === 'admin')

  users.resetPassword(users.findByUsername('admin').id, 'my-own-pass')
  check('改过密码后不再提示', users.pendingPresetAdmin() === null)
  check('preset 标记被清掉', users.findByUsername('admin').preset === undefined)
  check('新密码能登录', users.login({ username: 'admin', password: 'my-own-pass' }).ok === true)

  // 降级之后也不该再提示「用 admin/123456 登」——那个号已经批不了东西了
  const d2 = fresh()
  const u2 = new UserStore(d2)
  u2.ensureBootstrap()
  u2.register({ username: '阿宝', password: 'pass1234' })
  u2.setRole(u2.findByUsername('阿宝').id, ROLES.admin)
  u2.setRole(u2.findByUsername('admin').id, ROLES.member)
  check('降级后不再提示', u2.pendingPresetAdmin() === null)
}

console.log('\n== 参数不合法就不建 ==')
{
  const d = fresh()
  const users = new UserStore(d)
  const r = users.ensureBootstrap({ password: '123' })
  check('弱密码不建', r.created === false && !!r.error)
  check('表仍然是空的', users.list().length === 0)
  check('下次还能正常建', users.ensureBootstrap().created === true)
}

console.log('\n== 机器人账号：内置、不可登录、不可管理 ==')
{
  const d = fresh()
  const users = new UserStore(d)
  const created = users.ensureBot({ nickname: 'AI员工' })
  check('第一次启动建出机器人', created.created === true)
  check('角色是 bot', created.user.role === ROLES.bot, created.user.role)
  check('带 isBot 标记', created.user.isBot === true)
  check('对外也标 isBot', publicUser(users.botUser()).isBot === true)

  const again = users.ensureBot({ nickname: 'AI员工' })
  check('重复调用不会再建一个', again.created === false && users.list().length === 1)

  const renamed = users.ensureBot({ nickname: '产品同学' })
  check('改配置后昵称跟着变', renamed.user.nickname === '产品同学', renamed.user.nickname)
  check('id 不变（@ 的归属不会漂）', renamed.user.id === BOT_USER_ID)

  check('机器人不能登录', users.login({ username: 'bot', password: '123456' }).ok === false)
  check('机器人不能改角色', !!users.setRole(created.user.id, 'admin').error)
  check('机器人不能停用', !!users.setDisabled(created.user.id, true).error)
  check('机器人不能设密码', !!users.resetPassword(created.user.id, '123456').error)
}

console.log('\n== 用户表损坏时的行为 ==')
{
  const d = fresh()
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'users.json'), '{ 这不是 JSON')
  const users = new UserStore(d)
  check('坏表不抛错', users.list().length === 0)
  // 坏表被当成空表 → 预设账号会建出来。这是有意的：
  // 坏文件已经备份成 .broken-<ts>，但系统得能启动。
  const r = users.ensureBootstrap()
  check('坏表仍能建预设账号', r.created === true)
  const broken = readdirSync(d).filter((f) => f.includes('users.json.broken-'))
  check('坏文件被备份留证', broken.length === 1, readdirSync(d).join(','))
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
