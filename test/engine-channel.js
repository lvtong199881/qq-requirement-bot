/**
 * IM 与需求引擎拆开的那些接缝：
 *   1. 路由规则——哪句话是聊天、哪句话开需求、哪句话转给引擎；
 *   2. 事件队列——落盘、游标、长轮询；
 *   3. 引擎通道——鉴权、白名单、产物内联。
 *
 * 这三块是「IM 能独立部署」的前提：规则错了会在群里闲聊时偷偷 spawn agent，
 * 队列错了会在引擎重启时丢掉用户的需求，通道错了会把引擎那台的字段
 * 覆盖掉 IM 自己的数据。都是不会当场报错、事后很难查的问题。
 *
 *   node test/engine-channel.js
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOT_ID, mentionsOf, routeMessage, stripBotMention } from '../src/im/router.js'
import { EngineEvents } from '../src/im/events.js'
import { createEngineApi } from '../src/api/engine.js'
import { createApiServer } from '../src/api/server.js'
import { SessionStore } from '../src/state.js'
import { UserStore } from '../src/account/store.js'
import { MessageStore } from '../src/store/messages.js'
import { ArtifactStore } from '../src/store/artifacts.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const tmp = mkdtempSync(join(tmpdir(), 'qq-engine-'))

console.log('\n== 路由：不 @ 就是聊天 ==')
{
  const r = routeMessage({ mode: 'chat', mentions: [] })
  check('chat 群没 @ → chat', r.action === 'chat', r.action)
  check('atBot 为 false', r.atBot === false)
}

console.log('\n== 路由：@ 了也只是普通发言 ==')
{
  // v2 起需求只走 App 的「新需求」弹窗（POST /api/requirements），
  // 群里 @ 一下不再开流程——路由层就没有 start 这个动作了。
  const r = routeMessage({ mode: 'chat', mentions: [BOT_ID] })
  check('chat 群 @ → message', r.action === 'message', r.action)
  check('没有 start 动作', r.action !== 'start' && r.needsStart === undefined, String(r.needsStart))
}

console.log('\n== 路由：需求群里没 @ 的还是聊天 ==')
{
  const a = routeMessage({ mode: 'requirement', mentions: [] })
  check('需求群没 @ 也不惊动引擎', a.action === 'chat', a.action)
  check('需求群没 @ 时不带 atBot', a.atBot === false)
  const b = routeMessage({ mode: 'requirement', mentions: [BOT_ID] })
  check('需求群 @ 了才转引擎', b.action === 'message', b.action)
}

console.log('\n== @ 的识别：显式 mentions 和手打都要认 ==')
{
  check('显式 mentions 认', mentionsOf({ mentions: [BOT_ID], text: '随便' }).includes(BOT_ID))
  check('手打 @AI员工 认', mentionsOf({ text: '@AI员工 加个按钮' }).includes(BOT_ID))
  check('自定义 bot 名字也认', mentionsOf({ text: '@产品同学 加个按钮', botName: '产品同学' }).includes(BOT_ID))
  check('没 @ 不认', mentionsOf({ text: '加个按钮' }).length === 0)
  check('空文本不炸', mentionsOf({ text: null }).length === 0)
  check('去重', mentionsOf({ mentions: [BOT_ID, BOT_ID] }).length === 1)
  // 只认当前昵称：改名之后旧名字不该继续触发，否则「改名」并不能真正换掉触发词
  check(
    '改名后不认旧名字',
    !mentionsOf({ text: '@需求bot 加个按钮', botName: '产品同学' }).includes(BOT_ID),
  )
}

console.log('\n== 去掉 @：需求名不该以它开头 ==')
{
  check('去掉 @ 和多余空格', stripBotMention('@AI员工   加个欢迎弹窗') === '加个欢迎弹窗')
  check('中间出现的也去掉', stripBotMention('加个弹窗 @AI员工 谢谢') === '加个弹窗 谢谢')
  check('没 @ 时原样（去首尾空格）', stripBotMention('  加个弹窗  ') === '加个弹窗')
  check('自定义名字', stripBotMention('@产品同学 加个按钮', '产品同学') === '加个按钮')
  check('改名后不剥旧名字', stripBotMention('@需求bot 加个按钮', '产品同学') === '@需求bot 加个按钮')
}

console.log('\n== 事件队列：落盘 + 游标 ==')
{
  const dir = join(tmp, 'events')
  const events = new EngineEvents(dir)
  check('一开始没事件', events.cursor === 0 && events.since(0).length === 0)

  events.append('requirement', { threadId: 'tabc1234567', text: '加个弹窗' })
  events.append('message', { threadId: 'tabc1234567', text: '给新用户看' })
  check('游标推到最新', events.cursor === 2, String(events.cursor))
  check('since(0) 拿到两条', events.since(0).length === 2)
  check('since(1) 只拿后面的', events.since(1).length === 1 && events.since(1)[0].type === 'message')
  check('事件自带时间戳', typeof events.since(0)[0].at === 'number')

  // 引擎重启：换个实例读同一个目录，没读到就等于用户的需求消失了
  const reopened = new EngineEvents(dir)
  check('重启后事件还在', reopened.cursor === 2 && reopened.since(0).length === 2)

  // 单机模式：dir 为空只放内存
  const memory = new EngineEvents(null)
  memory.append('message', { threadId: 't1', text: 'hi' })
  check('无目录也能用', memory.cursor === 1)
}

console.log('\n== 事件队列：长轮询 ==')
{
  const events = new EngineEvents(null)
  const t0 = Date.now()
  const waiting = events.waitFor(0, 3000)
  // 模拟「用户就在这时说了话」
  setTimeout(() => events.append('requirement', { threadId: 'txyz8888888', text: '加个弹窗' }), 60)
  const got = await waiting
  check('挂着的轮询会被新事件唤醒', got.length === 1 && got[0].threadId === 'txyz8888888', JSON.stringify(got))
  check('没有被超时拖满 3 秒', Date.now() - t0 < 2000, `${Date.now() - t0}ms`)

  const t1 = Date.now()
  const empty = await events.waitFor(99, 120)
  check('没有新事件时等到超时返回空', empty.length === 0)
  check('确实等了', Date.now() - t1 >= 100, `${Date.now() - t1}ms`)

  // 进程要退出时不能把长轮询晾着，否则服务端会话一直挂着
  const pending = events.waitFor(99, 5000)
  events.close()
  check('close() 放掉挂着的轮询', (await pending).length === 0)
}

console.log('\n== 引擎通道 ==')
const groups = new SessionStore(tmp, join(tmp, 'state'))
const users = new UserStore(join(tmp, 'users'))
const messages = new MessageStore(join(tmp, 'messages'))
const artifacts = new ArtifactStore(join(tmp, 'artifacts'))
const events = new EngineEvents(join(tmp, 'engine'))
let engineToken = 'test-engine-token-abcdefghijklmnop'

const engineApi = () => createEngineApi({ events, messages, artifacts, groups, users, token: engineToken, log: () => {} })

const threads = {
  threadInfo: async () => null,
  listThreads: async () => [],
  deliver: async () => ({ ok: true }),
  createGroup: async () => ({ ok: true }),
}

const server = createApiServer({
  ...threads,
  users,
  messages,
  artifacts,
  engine: engineApi(),
  log: () => {},
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const hit = async (method, path, { token, body } = {}) => {
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

await users.ensureBootstrap()
const admin = users.list().find((u) => u.role === 'admin')

// 先造一个群：白名单要保证引擎改不动 IM 自己的字段
const groupId = 'tabcdefghijk'
groups.save(groupId, { status: 'idle', mode: 'chat', name: '周末闲聊', initiator: null, lastActiveAt: Date.now() })

{
  const r = await hit('GET', '/api/engine/status')
  check('状态接口不需要密钥', r.status === 200 && r.data?.ok === true, `${r.status}`)
  check('还没轮询过时是未知（不是掉线）', r.data?.online === null, JSON.stringify(r.data))
  check('带上了 bot 名字', typeof r.data?.botName === 'string' && r.data.botName.length > 0)
}

{
  const r = await hit('POST', '/api/engine/messages', { body: { groupId, kind: 'text', payload: { text: '偷偷发' } } })
  check('没密钥不能发消息', r.status === 401, String(r.status))

  const bad = await hit('POST', '/api/engine/messages', {
    token: 'wrong-token-aaaaaaaaaaaaaaaaaaa',
    body: { groupId, kind: 'text', payload: { text: '偷偷发' } },
  })
  check('密钥不对也是 401', bad.status === 401, String(bad.status))
}

{
  const r = await hit('GET', '/api/engine/inbox?after=0&wait=50', { token: engineToken })
  check('引擎能长轮询', r.status === 200 && Array.isArray(r.data?.events), `${r.status} ${JSON.stringify(r.data)}`)
  check('此时没有待办事件', r.data?.events?.length === 0)

  const s = await hit('GET', '/api/engine/status')
  check('轮询过之后算在线', s.data?.online === true, JSON.stringify(s.data))
}

{
  // 用户在群里 @ 了需求 bot：publisher 侧把事件塞进队列
  events.append('requirement', { threadId: groupId, text: '加个欢迎弹窗', user: { userId: admin.id, nickname: '管理员' } })
  const r = await hit('GET', '/api/engine/inbox?after=0&wait=50', { token: engineToken })
  check('引擎拿得到这条事件', r.data?.events?.[0]?.type === 'requirement', JSON.stringify(r.data))
  check('事件带着群 id 和文本', r.data?.events?.[0]?.threadId === groupId && r.data?.events?.[0]?.text === '加个欢迎弹窗')

  const next = await hit('GET', `/api/engine/inbox?after=${r.data.cursor}&wait=50`, { token: engineToken })
  check('游标之后没有重复', next.data?.events?.length === 0, JSON.stringify(next.data?.events))
}

{
  const r = await hit('POST', '/api/engine/messages', {
    token: engineToken,
    body: { groupId, kind: 'text', payload: { text: '收到，先问一句：这个弹窗给谁看？' } },
  })
  check('引擎能回话', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data))
  check('回话以 bot 身份落库', messages.list(groupId, { limit: 10 }).messages.at(-1)?.role === 'bot')

  const empty = await hit('POST', '/api/engine/messages', {
    token: engineToken,
    body: { groupId, kind: 'text', payload: { text: '   ' } },
  })
  check('空消息被拒', empty.status === 400)

  const weird = await hit('POST', '/api/engine/messages', {
    token: engineToken,
    body: { groupId, kind: 'sound', payload: {} },
  })
  check('不认识的消息类型被拒', weird.status === 400, String(weird.status))

  const noGroup = await hit('POST', '/api/engine/messages', {
    token: engineToken,
    body: { kind: 'text', payload: { text: 'hi' } },
  })
  check('缺 groupId 被拒', noGroup.status === 400)
}

{
  // 图片：引擎那台读不到 IM 的文件系统，所以字节跟着消息走
  const data = Buffer.from('fake-png-bytes').toString('base64')
  const r = await hit('POST', '/api/engine/messages', {
    token: engineToken,
    body: { groupId, kind: 'image', payload: { name: 'shot.png', data } },
  })
  check('图片能进来', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data))
  const msg = messages.list(groupId, { limit: 10 }).messages.at(-1)
  check('落的是产物地址而不是 base64', typeof msg?.payload?.url === 'string' && !msg.payload.data, JSON.stringify(msg?.payload))
  check('产物带名字和大小', msg?.payload?.name === 'shot.png' && msg?.payload?.size > 0)
}

{
  const r = await hit('POST', `/api/engine/groups/${groupId}`, {
    token: engineToken,
    body: {
      reqId: 'req-1',
      reqName: '欢迎弹窗',
      stage: '需求澄清',
      stageStatus: '进行中',
      running: true,
      waitingLabel: '',
      featureBranch: 'feat/welcome',
      // 下面这些是 IM 的地盘，引擎写了也不能生效
      name: '被改掉的群名',
      mode: 'requirement',
      evil: true,
    },
  })
  check('引擎能报阶段', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data))

  const saved = groups.get(groupId)
  check('阶段写进了占位', saved?.engine?.stage === '需求澄清', JSON.stringify(saved?.engine))
  check('需求名也记下了', saved?.engine?.reqName === '欢迎弹窗')
  check('运行状态也记下了', saved?.engine?.running === true)
  check('群名没被引擎改掉', saved?.name === '周末闲聊', saved?.name)
  check('模式没被引擎改掉', saved?.mode === 'chat', saved?.mode)
  check('白名单外的字段没落盘', saved?.evil === undefined && saved?.engine?.evil === undefined)

  const ghost = await hit('POST', '/api/engine/groups/tnotexist00', {
    token: engineToken,
    body: { stage: '需求澄清' },
  })
  check('不存在的群 404', ghost.status === 404, String(ghost.status))
}

{
  const ok = await hit('GET', `/api/engine/can?action=confirm&userId=${admin.id}`, { token: engineToken })
  check('权限：管理员通过', ok.data?.ok === true, JSON.stringify(ok.data))
  check('带上了角色名', ok.data?.roleLabel === '系统管理员', ok.data?.roleLabel)

  const ghost = await hit('GET', '/api/engine/can?action=confirm&userId=nobody', { token: engineToken })
  check('权限：查无此人 → 不放行', ghost.data?.ok === false, JSON.stringify(ghost.data))

  const noAction = await hit('GET', '/api/engine/can?userId=abc', { token: engineToken })
  check('缺 action 被拒', noAction.status === 400)
}

{
  // 引擎通道不能把普通 App 的接口抢走
  const r = await hit('GET', '/api/threads')
  check('普通接口仍然需要用户 token', r.status === 401, String(r.status))
}

{
  const r = await hit('GET', '/api/engine/inbox?after=0&wait=50', { token: engineToken })
  check('通道不会泄漏到未知路径', (await hit('GET', '/api/engine/nope', { token: engineToken })).status === 404)
  check('长轮询返回游标', typeof r.data?.cursor === 'number')
}

console.log('\n== 没配密钥时整段关闭 ==')
{
  const closed = createApiServer({
    ...threads,
    users,
    messages,
    artifacts,
    engine: createEngineApi({ events, messages, artifacts, groups, users, token: '', log: () => {} }),
    log: () => {},
  })
  await new Promise((r) => closed.listen(0, '127.0.0.1', r))
  const b = `http://127.0.0.1:${closed.address().port}`
  const res = await fetch(`${b}/api/engine/inbox`)
  const data = await res.json()
  check('引擎通道 503', res.status === 503, String(res.status))
  check('说清了为什么关着', /engineToken/.test(data?.error ?? ''), data?.error)
  await new Promise((r) => closed.close(r))
}

events.close()
await new Promise((r) => server.close(r))

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
