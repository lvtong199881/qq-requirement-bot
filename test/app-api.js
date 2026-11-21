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
import { isAppThread } from '../src/api/threads.js'

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
 * peek 的关键行为必须和真的一致：src/state.js 的 peek 在状态文件
 * 还不存在时会懒初始化**返回一个新对象**（而不是 null）。
 * createGroup 就靠这一点拿 st，假实现如果返回 null，
 * 「建群」这条链在测试里根本跑不起来——而线上是好的。
 */
const machine = {
  peek: (id) => {
    if (!machines.has(id)) {
      // 新 thread：模拟 resolveGroup 通过后返回的初始状态
      machines.set(id, { groupId: id, status: 'idle', turn: 0, lastActiveAt: Date.now() })
    }
    return machines.get(id)
  },
  store: {
    save: (id, st) => machines.set(id, st),
    // 和 src/state.js 的 SessionStore.get 一样：文件不存在返回 null。
    // 测试里必须区分「落过盘」和「压根没有」——threadInfo 就靠这个判 404，
    // 全用 peek 的话任何 id 都算存在，未知需求永远返回 200。
    get: (id) => machines.get(id) ?? null,
    allGroupIds: () => [...machines.keys()],
  },
}

/** 假的引擎：记录被投递了什么，不真的跑回合 */
const delivered = []
const dispatch = async (ev) => {
  delivered.push({
    type: ev.type,
    groupId: ev.threadId,
    text: ev.text,
    mentions: ev.mentions ?? [],
    // 提问卡片的勾选结果：断言要能看出「提交了哪张卡、勾了什么」
    answers: ev.answers ?? null,
    askSeq: ev.askSeq ?? null,
  })
  // 真引擎在 startNewRequirement 里绑 reqId 并开始推进阶段。
  // 不补这一步，群会一直停在「待提需求」，断言就看不出区别。
  const st = machines.get(ev.threadId)
  if (st && ev.type === 'start') {
    st.reqId = `req-${ev.threadId}`
    st.flow = {
      name: ev.text.slice(0, 30),
      reqId: st.reqId,
      stage: '需求澄清',
      stageStatus: '进行中',
      stages: [],
    }
  }
}

const users = new UserStore(tmp)
const messages = new MessageStore(join(tmp, 'messages'))
const artifacts = new ArtifactStore(join(tmp, 'artifacts'))

// 面板快照的形状要和真的一样：threads.js 的 toThread 就按这些字段取值。
// 特别注意 legacy 分支——src/index.js 的 buildSnapshot 对「有状态但还没 flow」
// 的会话返回的是「旧版需求」占位项。刚建出来的 thread 就处在这个窗口里，
// mock 如果不复现这一点，新建需求的可见性问题在测试里永远暴露不出来。
const buildSnapshot = async () => ({
  groups: [...machines.values()].map((st) =>
    st.flow
      ? {
          groupId: st.groupId,
          name: st.flow.name ?? null,
          reqId: st.flow.reqId ?? null,
          stage: st.flow.stage ?? '需求澄清',
          stageStatus: st.flow.stageStatus ?? '进行中',
          status: 'waiting',
          waitingLabel: '',
          turn: st.turn ?? 0,
          initiator: st.initiator ?? null,
          lastActiveAt: st.lastActiveAt ?? Date.now(),
          activeTurn: false,
          stages: st.flow.stages ?? [],
          featureBranch: null,
        }
      : {
          groupId: st.groupId,
          name: null,
          reqId: st.reqId ?? null,
          stage: null,
          stageStatus: '旧版需求',
          status: 'idle',
          waitingLabel: 'v2 不接管旧版绑定的需求',
          turn: st.turn ?? 0,
          initiator: st.initiator ?? null,
          lastActiveAt: st.lastActiveAt ?? null,
          activeTurn: false,
          stages: [],
          featureBranch: null,
          legacy: true,
        },
  ),
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
  store: machine.store,
  messages,
  buildSnapshot,
  dispatch,
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
  createGroup: threads.createGroup,
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
  // 这个测试自己起 UserStore，不会像 index.js 那样调 ensureBootstrap，
  // 所以这里的状态就是「真·空表」。预设账号的行为在 test/account.js 里测。
  const r = await api('GET', '/api/auth/status')
  check('needsFirstAdmin 为 true', r.data?.needsFirstAdmin === true)
  check('没有预设账号时不提示初始密码', r.data?.presetAdmin === null && r.data?.presetPassword === null)
}

console.log('\n== 首屏：有没改过密码的预设账号时给出账号和密码 ==')
{
  // 模拟 index.js 启动时建了预设账号的那台机器
  const presetUsers = new UserStore(mkdtempSync(join(tmpdir(), 'qq-preset-')))
  presetUsers.ensureBootstrap()
  const presetSrv = createApiServer({
    users: presetUsers,
    messages,
    artifacts,
    threadInfo: threads.threadInfo,
    listThreads: threads.listThreads,
    deliver: threads.deliver,
    createGroup: threads.createGroup,
    log: () => {},
  })
  await new Promise((r) => presetSrv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${presetSrv.address().port}`
  const r = await (await fetch(`${base}/api/auth/status`)).json()
  check('返回了预设账号名', r.presetAdmin === 'admin')
  check('返回了预设密码', r.presetPassword === '123456')
  check('有管理员了所以不催注册', r.needsFirstAdmin === false)

  // 改过密码之后这俩字段必须消失，否则 App 会一直显示一个登不进去的号码
  presetUsers.resetPassword(presetUsers.findByUsername('admin').id, 'my-own-pass')
  const r2 = await (await fetch(`${base}/api/auth/status`)).json()
  check('改密码后不再返回预设账号', r2.presetAdmin === null)
  check('改密码后不再返回预设密码', r2.presetPassword === null)

  await new Promise((r) => presetSrv.close(r))
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

console.log('\n== 建群：只有管理员能建 ==')
let threadId = ''
{
  const denied = await api('POST', '/api/threads', {
    token: memberToken,
    body: { name: '首页改版' },
  })
  check('普通成员被拒 403', denied.status === 403, String(denied.status))
  check('说明了需要管理员', /管理员/.test(denied.data?.error ?? ''), denied.data?.error)

  const ok = await api('POST', '/api/threads', {
    token: adminToken,
    body: { name: '首页改版' },
  })
  check('管理员能建群', ok.status === 200 && ok.data?.ok === true, JSON.stringify(ok.data).slice(0, 200))
  threadId = ok.data?.threadId
  check('返回了 threadId', typeof threadId === 'string' && threadId.startsWith('t'), threadId)
  check('threadId 被识别为 App 会话', isAppThread(threadId) === true)
  // 建群只是建容器：不投递、不落用户消息。需求等群里第一句话——
  // 建群接口要是顺手把需求跑起来，流程又退回「先填需求再建群」了。
  check('建群没有投递需求', !delivered.some((d) => d.groupId === threadId))
  check('建群没往群里塞用户消息', messages.list(threadId, { limit: 10 }).messages.length === 0)
  // 新建后立刻要能拿到详情：快照里此时还没有 flow，回退到落盘状态。
  // 这里返回 null 的话，App 建完群跳详情页会 404，只能盲轮询。
  check('新建接口直接返回了 thread 形状', Boolean(ok.data?.thread), JSON.stringify(ok.data).slice(0, 200))
  check(
    '刚建好的群标着待提需求',
    ok.data?.thread?.pending === true && ok.data?.thread?.stageStatus === '待提需求',
    JSON.stringify(ok.data?.thread),
  )
  check('群名存下来了', ok.data?.thread?.groupName === '首页改版', ok.data?.thread?.groupName)
  check('返回值带了发起人', ok.data?.thread?.initiator?.nickname != null)

  const detail = await api('GET', `/api/threads/${threadId}`, { token: adminToken })
  check(
    '空群查详情不是 404',
    detail.status === 200 && detail.data?.thread?.groupName === '首页改版',
    `${detail.status} ${JSON.stringify(detail.data?.thread)?.slice(0, 120)}`,
  )

  const list = await api('GET', '/api/threads', { token: adminToken })
  check(
    '空群出现在列表里且带群名',
    (list.data?.threads ?? []).some((t) => t.threadId === threadId && t.groupName === '首页改版'),
  )
}

console.log('\n== 群里不 @ 就是普通聊天 ==')
{
  // 这条是「当普通 IM 用」的核心：没 @ 需求 bot，就只是聊天——
  // 引擎不该被打扰，群也不该变成需求群
  const r = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '今天几点上线？' },
  })
  check('普通成员能在群里聊天', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data))
  check('聊天不投给引擎', r.data?.action === 'chat' && delivered.length === 0, JSON.stringify(delivered))
  check(
    '聊天消息也落库',
    messages.list(threadId, { limit: 10 }).messages.some((m) => m.payload?.text === '今天几点上线？'),
  )

  const detail = await api('GET', `/api/threads/${threadId}`, { token: adminToken })
  check('群还是聊天模式', detail.data?.thread?.mode === 'chat', detail.data?.thread?.mode)
  check('群里还没有需求', detail.data?.thread?.pending === true)
}

console.log('\n== @AI员工 才算提需求 ==')
{
  // 普通成员 @ 一下也要被拒，否则 startRequirement 就被绕过去了
  const before = messages.list(threadId, { limit: 100 }).messages.length
  const denied = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '@AI员工 给首页加个欢迎弹窗', mentions: ['bot'] },
  })
  check('普通成员提需求被拒 403', denied.status === 403, String(denied.status))
  check('提示需要管理员', /管理员/.test(denied.data?.error ?? ''), denied.data?.error)
  check('被拒的话没有落库', messages.list(threadId, { limit: 100 }).messages.length === before)

  const r = await api('POST', `/api/threads/${threadId}/messages`, {
    token: adminToken,
    body: { text: '@AI员工 给首页加个欢迎弹窗', mentions: ['bot'] },
  })
  check('管理员能提需求', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data))
  check(
    '交给引擎的是 start，且 @ 已经去掉',
    delivered.some((d) => d.type === 'start' && d.text === '给首页加个欢迎弹窗'),
    JSON.stringify(delivered),
  )
  check(
    '@ 的痕迹留在消息里（气泡要能高亮）',
    messages.list(threadId, { limit: 100 }).messages.some((m) => (m.payload?.mentions ?? []).length > 0),
  )

  const detail = await api('GET', `/api/threads/${threadId}`, { token: adminToken })
  check('群变成需求模式', detail.data?.thread?.mode === 'requirement', detail.data?.thread?.mode)
  check('不再是待提需求', detail.data?.thread?.pending === false)
}

console.log('\n== 消息顺序：用户的话必须在 bot 播报之前 ==')
{
  // 模拟引擎开始播报
  messages.append(threadId, { role: 'bot', kind: 'text', payload: { text: '收到，先做需求澄清：这个弹窗给谁看？' } })

  const r = await api('GET', `/api/threads/${threadId}/messages`, { token: memberToken })
  const list = r.data?.messages ?? []
  check('两条自己说的 + 一条 bot', list.length === 3, String(list.length))
  check('最后一条是 bot', list.at(-1)?.role === 'bot', list.at(-1)?.role)
  check('bot 之前是刚提的需求', list.at(-2)?.payload?.text === '@AI员工 给首页加个欢迎弹窗')
  check('seq 递增', list.every((m, i) => i === 0 || m.seq === list[i - 1].seq + 1))
}

console.log('\n== 增量拉取：since 只给新消息 ==')
{
  const all = await api('GET', `/api/threads/${threadId}/messages`, { token: memberToken })
  const seq = all.data.messages.at(-1).seq - 1
  const r = await api('GET', `/api/threads/${threadId}/messages?since=${seq}`, { token: memberToken })
  check('只返回后面的消息', r.data?.messages?.length === 1, String(r.data?.messages?.length))
  check('lastSeq 是最新序号', r.data?.lastSeq === all.data.lastSeq)
}

console.log('\n== 需求群里：@ 了才转引擎，没 @ 还是聊天 ==')
{
  const plain = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '顺便问下这周谁值班' },
  })
  check('没 @ 也能发言', plain.status === 200 && plain.data?.action === 'chat', plain.data?.action)
  check(
    '没 @ 就不惊动引擎',
    !delivered.some((d) => d.type === 'message' && d.text === '顺便问下这周谁值班'),
    JSON.stringify(delivered.slice(-2)),
  )

  const at = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '@AI员工 给新用户看，第一次打开的时候弹', mentions: ['bot'] },
  })
  check('@ 之后发言成功', at.status === 200 && at.data?.action === 'message', at.data?.action)
  check(
    '@ 了才转给引擎',
    delivered.some((d) => d.type === 'message' && d.text === '给新用户看，第一次打开的时候弹'),
    JSON.stringify(delivered.slice(-2)),
  )

  // 提问卡片上点「提交」= 按钮，不该再要求用户 @ 一次；
  // 但权限口径和原来的通过/打回一致：只有能确认的人能提交。
  const cardBody = {
    text: '1. 弹窗时机？ A. 首次启动',
    answers: [{ qid: 'q1', optionIds: ['a'], input: '' }],
    askSeq: 7,
  }
  const deniedCard = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: cardBody,
  })
  check('普通成员点卡片提交被拒', deniedCard.status === 403, deniedCard.status)
  check('拒绝原因是权限', deniedCard.data?.error === '通过和打回只有系统管理员能操作', deniedCard.data?.error)

  const picked = await api('POST', `/api/threads/${threadId}/messages`, {
    token: adminToken,
    body: cardBody,
  })
  check('管理员点卡片提交也能发言', picked.status === 200 && picked.data?.action === 'message', picked.data?.action)
  const cardEvent = delivered.filter((d) => Array.isArray(d.answers) && d.answers.length).pop()
  check('勾选结果带给引擎', cardEvent?.answers?.[0]?.optionIds?.[0] === 'a', JSON.stringify(cardEvent))
  check('记下了回答的是哪张卡', cardEvent?.askSeq === 7, String(cardEvent?.askSeq))

  const empty = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '   ' },
  })
  check('空消息被拒', empty.status === 400)

  const rel = await api('POST', `/api/threads/${threadId}/messages`, {
    token: memberToken,
    body: { text: '@AI员工 /release', mentions: ['bot'] },
  })
  check('普通成员 /release 被拒 403', rel.status === 403, String(rel.status))
  check('拒绝原因是权限', rel.data?.error === '只有系统管理员能释放会话', rel.data?.error)
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

console.log('\n== 需求列表不混入 QQ 群 ==')
{
  // 跑过 QQ 群的机器，.state 里躺着真实群记录（有 flow、legacy 是 undefined）。
  // 按 `!legacy` 过滤会把它们全带出来——App 用户看到没建过的需求，
  // 点进去发言还会发进那个 QQ 群。
  machines.set('1132422327', {
    groupId: '1132422327',
    name: 'Instanto 欢迎弹窗',
    reqId: 'instanto-popup',
    stage: '已交付',
    stageStatus: '已完成',
    turn: 0,
    lastActiveAt: 0,
  })

  const r = await api('GET', '/api/threads', { token: adminToken })
  const ids = (r.data?.threads ?? []).map((t) => t.threadId)
  check('列表里没有 QQ 群号', !ids.includes('1132422327'), ids.join(','))
  check('App 需求还在', ids.includes(threadId), ids.join(','))

  const qq = await api('GET', '/api/threads/1132422327', { token: adminToken })
  check('按 QQ 群号查详情 404', qq.status === 404, String(qq.status))
  const qqMsg = await api('GET', '/api/threads/1132422327/messages', { token: adminToken })
  check('按 QQ 群号拉消息 404', qqMsg.status === 404, String(qqMsg.status))

  machines.delete('1132422327')
}

console.log('\n== 不存在的需求 → 404 ==')
{
  const r = await api('GET', '/api/threads/tdeadbeef000/messages', { token: adminToken })
  check('未知 thread 返回 404', r.status === 404, String(r.status))

  // peek 对任何 id 都凭空造状态，拿它判断存在性等于永远存在。
  // threadInfo 必须查已落盘的状态，不能查 peek 的结果。
  const d = await api('GET', '/api/threads/tdeadbeef000', { token: adminToken })
  check('未知 thread 查详情 404', d.status === 404, String(d.status))
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
