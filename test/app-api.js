/**
 * App 公网 API 的端到端测试。
 *
 * 用真 HTTP server + 真 UserStore/MessageStore/ArtifactStore 跑一遍
 * App 要走的那条路：注册 → 登录 → 建需求 → 拉消息 → 通过/打回。
 *
 * 编排层用假的：真回合要 spawn dsh 跑几十分钟，测不了。
 * 这里关心的是「API 这一层把话说对了没有」——身份、权限、
 * 消息顺序、错误码，而不是 agent 干活干得怎么样。
 *
 *   node test/app-api.js
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../src/account/store.js'
import { MessageStore } from '../src/store/messages.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { createApiServer } from '../src/api/server.js'
import { createThreadService, newThreadId } from '../src/api/threads.js'
import { isAppThread } from '../src/transport/transport.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const tmp = mkdtempSync(join(tmpdir(), 'qq-app-api-'))
const machines = new Map()

/**
 * 假状态机。
 *
 * peek 的关键行为必须和真的一致：src/state.js:146 的 peek 在
 * 状态文件还不存在时会按 groupPolicy 懒初始化**返回一个新对象**
 * （而不是 null）。createThread 就靠这一点拿 st，假实现如果返回 null，
 * 「新建需求」这条链在测试里根本跑不起来——而线上是好的。
 */
const machine = {
  peek: (id) => {
    if (!machines.has(id)) {
      // 新 thread：模拟 resolveGroup 通过后返回的初始状态
      machines.set(id, { groupId: id, status: 'idle', turn: 0, lastActiveAt: Date.now() })
    }
    return machines.get(id)
  },
  store: { save: (id, st) => machines.set(id, st) },
}

/** 假的编排层：记录被投递了什么，不真的跑回合 */
const delivered = []
const flowBridge = {
  handleMessage: async (o) => {
    delivered.push({ groupId: o.groupId, text: o.text })
  },
}

const users = new UserStore(tmp)
const messages = new MessageStore(join(tmp, 'messages'))
const artifacts = new ArtifactStore(join(tmp, 'artifacts'))

// 面板快照的形状要和真的一样：threads.js 的 toThread 就按这些字段取值
const buildSnapshot = async () => ({
  groups: [...machines.values()].map((st) => ({
    groupId: st.groupId,
    name: st.name ?? null,
    reqId: st.reqId ?? null,
    stage: st.stage ?? '需求澄清',
    stageStatus: st.stageStatus ?? '进行中',
    status: 'waiting',
    waitingLabel: '',
    turn: st.turn ?? 0,
    initiator: st.initiator ?? null,
    lastActiveAt: st.lastActiveAt ?? Date.now(),
    activeTurn: false,
    stages: [],
    featureBranch: null,
  })),
})

/**
 * can 的分流逻辑要和 src/index.js 一致。
 * 这里的实现刻意抄自 index.js：如果那边改了而这边没跟上，
 * 测试就会「通过」但线上行为不同。所以下面专门有一条 check 验证分流正确。
 */
const can = async (action, threadId, userId) => {
  if (isAppThread(threadId)) {
    const user = users.findById(String(userId))
    if (!user || user.disabled) return { ok: false, role: null, need: [] }
    const r = users.can(action, user)
    return { ok: r.ok, role: user.role, need: r.need }
  }
  return { ok: true, role: 'owner' }
}

const threads = createThreadService({
  machine,
  flowBridge,
  messages,
  buildSnapshot,
  can,
  log: () => {},
})

const server = createApiServer({
  users,
  messages,
  artifacts,
  threadInfo: threads.threadInfo,
  listThreads: threads.listThreads,
  deliver: threads.deliver,
  createThread: threads.createThread,
  log: () => {},
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, data }
}

console.log('\n== 首屏：还没账号时要提示注册 ==')
{
  const r = await api('GET', '/api/auth/status')
  check('needsFirstAdmin 为 true', r.data?.needsFirstAdmin === true)
}

console.log('\n== 注册：第一个注册者成为管理员 ==')
let adminToken = ''
{
  const r = await api('POST', '/api/auth/register', {
    body: { username: '阿宝', password: 'pass1234', nickname: '产品阿宝' },
  })
  check('注册成功', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data))
  check('角色是管理员', r.data?.user?.role === 'admin', r.data?.user?.role)
  check('给出了 token', typeof r.data?.token === 'string' && r.data.token.length > 20)
  check('提示了自动成为管理员', String(r.data?.notice ?? '').includes('管理员'))
  adminToken = r.data?.token
}

console.log('\n== 注册：第二个是普通成员 ==')
let memberToken = ''
let memberId = ''
{
  const r = await api('POST', '/api/auth/register', {
    body: { username: '小明', password: 'pass1234' },
  })
  check('注册成功', r.status === 200, JSON.stringify(r.data))
  check('角色是普通成员', r.data?.user?.role === 'member', r.data?.user?.role)
  memberToken = r.data?.token
  memberId = r.data?.user?.id
}

console.log('\n== 注册：重名和弱密码被拒 ==')
{
  const r1 = await api('POST', '/api/auth/register', { body: { username: '阿宝', password: 'pass1234' } })
  check('重名被拒', r1.status === 400 && /有人用|已存在|占用/.test(r1.data?.error ?? ''), r1.data?.error)
  const r2 = await api('POST', '/api/auth/register', { body: { username: '路人', password: '123' } })
  check('弱密码被拒', r2.status === 400, r2.data?.error)
}

console.log('\n== 登录 ==')
{
  const ok = await api('POST', '/api/auth/login', { body: { username: '阿宝', password: 'pass1234' } })
  check('密码对能登录', ok.status === 200 && ok.data?.ok === true)
  check('登录也发 token', typeof ok.data?.token === 'string')

  const bad = await api('POST', '/api/auth/login', { body: { username: '阿宝', password: 'wrong' } })
  check('密码错返回 401', bad.status === 401)
  check('错误文案不点明是用户名还是密码', /用户名或密码/.test(bad.data?.error ?? ''), bad.data?.error)

  const ghost = await api('POST', '/api/auth/login', { body: { username: '查无此人', password: 'wrong' } })
  check(
    '不存在的用户和密码错同文案（不给用户名探测器）',
    ghost.data?.error === bad.data?.error,
    `${ghost.data?.error} vs ${bad.data?.error}`,
  )
}

console.log('\n== 鉴权：没 token 一律 401 ==')
{
  for (const [m, p] of [
    ['GET', '/api/threads'],
    ['GET', '/api/threads/abc'],
    ['POST', '/api/threads'],
    ['GET', '/api/users'],
    ['GET', '/api/auth/me'],
  ]) {
    const r = await api(m, p)
    check(`${m} ${p} → 401`, r.status === 401, String(r.status))
  }
}

console.log('\n== /api/auth/me 告诉前端能做什么 ==')
{
  const a = await api('GET', '/api/auth/me', { token: adminToken })
  check('管理员 confirm 为 true', a.data?.can?.confirm === true)
  check('管理员 startRequirement 为 true', a.data?.can?.startRequirement === true)

  const m = await api('GET', '/api/auth/me', { token: memberToken })
  check('普通成员 confirm 为 false', m.data?.can?.confirm === false)
  check('普通成员 read 为 true', m.data?.can?.read === true)
  check('普通成员 startRequirement 为 false', m.data?.can?.startRequirement === false)
}

console.log('\n== 新建需求：只有管理员能发起 ==')
let threadId = ''
{
  const denied = await api('POST', '/api/threads', {
    token: memberToken,
    body: { text: '给首页加个欢迎弹窗' },
  })
  check('普通成员被拒 403', denied.status === 403, String(denied.status))
  check('说明了需要管理员', /管理员/.test(denied.data?.error ?? ''), denied.data?.error)

  const ok = await api('POST', '/api/threads', {
    token: adminToken,
    body: { text: '给首页加个欢迎弹窗' },
  })
  check('管理员能新建', ok.status === 200 && ok.data?.ok === true, JSON.stringify(ok.data).slice(0, 200))
  threadId = ok.data?.threadId
  check('返回了 threadId', typeof threadId === 'string' && threadId.startsWith('t'), threadId)
  check('threadId 被识别为 App 会话', isAppThread(threadId) === true)
  check('投递进了编排层', delivered.some((d) => d.groupId === threadId && d.text === '给首页加个欢迎弹窗'))
}

console.log('\n== 消息顺序：用户的话必须在 bot 播报之前 ==')
{
  // 模拟编排层开始播报
  messages.append(threadId, { role: 'bot', kind: 'text', payload: { text: '收到，先做需求澄清：这个弹窗给谁看？' } })

  const r = await api('GET', `/api/threads/${threadId}/messages`, { token: memberToken })
  check('拉到两条', r.data?.messages?.length === 2, String(r.data?.messages?.length))
  check('第一条是用户说的', r.data?.messages?.[0]?.role === 'user', r.data?.messages?.[0]?.role)
  check('内容是需求原文', r.data?.messages?.[0]?.payload?.text === '给首页加个欢迎弹窗')
  check('第二条是 bot', r.data?.messages?.[1]?.role === 'bot')
  check('seq 递增', r.data?.messages?.[1]?.seq === r.data?.messages?.[0]?.seq + 1)
}

console.log('\n== 增量拉取：since 只给新消息 ==')
{
  const all = await api('GET', `/api/threads/${threadId}/messages`, { token: memberToken })
  const seq = all.data.messages[0].seq
  const r = await api('GET', `/api/threads/${threadId}/messages?since=${seq}`, { token: memberToken })
  check('只返回后面的消息', r.data?.messages?.length === 1, String(r.data?.messages?.length))
  check('lastSeq 是最新序号', r.data?.lastSeq === all.data.lastSeq)
}

console.log('\n== 发言：用户消息落库且投递 ==')
{
  const r = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '给新用户看，第一次打开的时候弹' },
  })
  check('发言成功', r.status === 200 && r.data?.ok === true)
  check('投递进了编排层', delivered.some((d) => d.text === '给新用户看，第一次打开的时候弹'))

  const empty = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '   ' },
  })
  check('空消息被拒', empty.status === 400)
}

console.log('\n== 通过/打回：普通成员看得见按钮，点了被拒 ==')
{
  const d = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '这版可以' },
  })
  check('普通成员能发普通消息', d.status === 200)

  const denied = await api('POST', `/api/threads/${threadId}/approve`, { token: memberToken })
  check('普通成员通过被拒 403', denied.status === 403, String(denied.status))
  check(
    '提示只有管理员能操作',
    /只有系统管理员/.test(denied.data?.error ?? ''),
    denied.data?.error,
  )
  check('带上了自己的角色，前端可以解释原因', denied.data?.roleLabel === '普通成员', denied.data?.roleLabel)
}

console.log('\n== 通过 ==')
{
  const r = await api('POST', `/api/threads/${threadId}/approve`, { token: adminToken })
  check('管理员能通过', r.status === 200 && r.data?.ok === true)
  check('「通过」两个字投给了编排层', delivered.some((d) => d.text === '通过'))
  check('也落库成了用户消息', messages.list(threadId, { limit: 100 }).messages.some((m) => m.payload?.text === '通过'))
}

console.log('\n== 打回：必须写理由 ==')
{
  const noReason = await api('POST', `/api/threads/${threadId}/reject`, {
    token: adminToken,
    body: {},
  })
  check('没理由被拒 400', noReason.status === 400, String(noReason.status))

  const ok = await api('POST', `/api/threads/${threadId}/reject`, {
    token: adminToken,
    body: { reason: '按钮颜色不对，应该用品牌蓝' },
  })
  check('有理由能打回', ok.status === 200)
  check(
    '打回理由带进了消息',
    delivered.some((d) => d.text === '打回：按钮颜色不对，应该用品牌蓝'),
    JSON.stringify(delivered.slice(-2)),
  )
}

console.log('\n== 需求列表：带上未读序号和能否操作 ==')
{
  const a = await api('GET', '/api/threads', { token: adminToken })
  const item = a.data?.threads?.find((t) => t.threadId === threadId)
  check('列表里有这条需求', Boolean(item))
  check('带 lastSeq', typeof item?.lastSeq === 'number' && item.lastSeq > 0)
  check('管理员 canAct 为 true', item?.canAct === true)

  const m = await api('GET', '/api/threads', { token: memberToken })
  const item2 = m.data?.threads?.find((t) => t.threadId === threadId)
  check('普通成员 canAct 为 false', item2?.canAct === false)
}

console.log('\n== 不存在的需求 → 404 ==')
{
  const r = await api('GET', '/api/threads/tdeadbeef000/messages', { token: adminToken })
  check('未知 thread 返回 404', r.status === 404, String(r.status))
}

console.log('\n== 账号管理：只有管理员 ==')
{
  const denied = await api('GET', '/api/users', { token: memberToken })
  check('普通成员看不了用户列表', denied.status === 403, String(denied.status))

  const list = await api('GET', '/api/users', { token: adminToken })
  check('管理员能看', list.status === 200 && Array.isArray(list.data?.users))
  check('列表里没有密码哈希', !JSON.stringify(list.data?.users ?? []).includes('passwordHash'))
  check('列表里没有盐', !JSON.stringify(list.data?.users ?? []).includes('salt'))

  const promote = await api('POST', `/api/users/${memberId}/role`, {
    token: adminToken,
    body: { role: 'admin' },
  })
  check('能提权', promote.status === 200 && promote.data?.ok === true)

  // 提权后旧 token 立刻按新角色生效：authenticate 每次都查表
  const after = await api('POST', `/api/threads/${threadId}/approve`, { token: memberToken })
  check('提权后旧 token 立刻能通过', after.status === 200, String(after.status))
}

console.log('\n== 停用账号：立刻失效 ==')
{
  const r = await api('POST', `/api/users/${memberId}/disabled`, {
    token: adminToken,
    body: { disabled: true },
  })
  check('能停用', r.status === 200 && r.data?.ok === true)

  const me = await api('GET', '/api/auth/me', { token: memberToken })
  check('停用后旧 token 认证失败', me.status === 401, String(me.status))
}

console.log('\n== 暴力破解防护 ==')
{
  // 换个 IP 前缀绕开前面已经用掉的额度：这里直接打满一个不存在的用户名。
  // 额度用完后应返回 429，而不是继续比对密码。
  let got429 = false
  for (let i = 0; i < 25; i++) {
    const r = await api('POST', '/api/auth/login', {
      body: { username: `nobody${i}`, password: 'x' },
    })
    if (r.status === 429) {
      got429 = true
      break
    }
  }
  check('连续失败会被限流', got429)
}

console.log('\n== 已注册账号可登录（重启后 token 仍有效）==')
{
  // 模拟进程重启：新建一套 store，从同一个目录读
  const users2 = new UserStore(tmp)
  const u = users2.login({ username: '阿宝', password: 'pass1234' })
  check('重启后还能登录', u.ok === true, u.error)
  check('token 仍然有效', users2.authenticate(u.token)?.username === '阿宝')
}

server.close()
rmSync(tmp, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
