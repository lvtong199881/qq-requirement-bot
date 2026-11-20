/**
 * 传输层分流测试。
 *
 * 这是整个 App 化改造最容易出静默故障的一处：编排层把「会话标识」
 * 当不透明字符串用，QQ 群号和 App 的 threadId 走同一个参数。
 * 如果分流判错，threadId 会走 OneBot，而 onebot.js 里是
 * `group_id: Number(groupId)` —— Number('t123abc') 是 NaN，
 * JSON 序列化后变 null，于是消息**不报错地**发到一个不存在的群。
 * 用户看到的是「App 里没反应」，日志里却没有一行错误。
 *
 * 所以这里逐条钉死：谁该走哪条路、落库什么、不落库什么。
 *
 *   node test/transport.js
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageStore } from '../src/store/messages.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { createTransport, isAppThread } from '../src/transport/transport.js'
import { newThreadId } from '../src/api/threads.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const tmp = mkdtempSync(join(tmpdir(), 'qq-transport-'))
const messages = new MessageStore(join(tmp, 'messages'))
const artifacts = new ArtifactStore(join(tmp, 'artifacts'))

/** 记录假 bot 收到了什么 */
const botCalls = []
const bot = {
  sendGroupMsg: async (id, content) => {
    botCalls.push({ kind: 'msg', id, content })
  },
  uploadGroupFile: async (id, path, name) => {
    botCalls.push({ kind: 'file', id, path, name })
  },
}

const logs = []
const transport = createTransport({
  bot,
  messages,
  artifacts,
  log: (m) => logs.push(m),
})

console.log('\n== 会话类型判定 ==')
{
  check('QQ 群号是数字', isAppThread('123456') === false)
  check('长群号也是数字', isAppThread('98765432109') === false)
  check('threadId 是 App 会话', isAppThread(newThreadId()) === true)
  check('t 开头短串算 App', isAppThread('tabc') === true)
  check('单独一个 t 不算（更像脏数据）', isAppThread('t') === false)
  check('空值是 QQ（保持老行为）', isAppThread('') === false)
  check('null 是 QQ（保持老行为）', isAppThread(null) === false)
  check('纯数字不因为长度被误判', isAppThread('12') === false)
  check('生成 100 个 id 都不重复', new Set(Array.from({ length: 100 }, newThreadId)).size === 100)
}

console.log('\n== 发文本：App 落库，不走 bot ==')
{
  const before = botCalls.length
  const tid = newThreadId()
  await transport.sendText(tid, '需求澄清通过了')
  check('bot 没收到', botCalls.length === before, `${botCalls.length} vs ${before}`)
  const list = messages.list(tid)
  check('落了一条', list.messages.length === 1)
  check('角色是 bot', list.messages[0].role === 'bot')
  check('kind 是 text', list.messages[0].kind === 'text')
  check('文本原样', list.messages[0].payload.text === '需求澄清通过了')
}

console.log('\n== 发文本：QQ 群走 bot，不落库 ==')
{
  const before = botCalls.length
  await transport.sendText('123456', '阶段播报')
  check('bot 收到了', botCalls.length === before + 1)
  check('发给了正确的群', botCalls.at(-1).id === '123456')
  check('内容是原文', botCalls.at(-1).content === '阶段播报')
  check('QQ 群没有落库', messages.list('123456').messages.length === 0)
}

console.log('\n== 发图片 ==')
{
  const tid = newThreadId()
  const buf = Buffer.from('PNGDATA')
  await transport.sendImage(tid, { buffer: buf, name: '首页.png' })

  check('App 不调 bot', !botCalls.some((c) => c.kind === 'msg' && c.id === tid))
  const list = messages.list(tid)
  check('落了一条图片消息', list.messages.length === 1)
  check('kind 是 image', list.messages[0].kind === 'image')
  check('带了可下载 url', String(list.messages[0].payload.url).includes('/artifacts/'))
  check('带了文件名', list.messages[0].payload.name === '首页.png')

  // url 里的 token 真能下载到原字节
  const url = list.messages[0].payload.url
  const token = url.split('/artifacts/')[1]
  const hit = artifacts.resolve(tid, token)
  check('url 里的 token 能解析到文件', Boolean(hit), url)
  check('文件名保留了中文', hit?.name === '首页.png', hit?.name)
}

console.log('\n== 发图片：QQ 走 base64 ==')
{
  const before = botCalls.length
  await transport.sendImage('123456', { buffer: Buffer.from('X'), name: 'a.png' })
  check('bot 收到了', botCalls.length === before + 1)
  const call = botCalls.at(-1)
  check('是图片段', call.content?.[0]?.type === 'image')
  check('用 base64 内联（NapCat 可能看不到宿主机路径）', String(call.content?.[0]?.data?.file).startsWith('base64://'))
}

console.log('\n== 发文件 ==')
{
  const tid = newThreadId()
  const src = join(tmp, '交付说明.md')
  writeFileSync(src, '# 交付\n内容')
  await transport.sendFile(tid, src, '交付说明.md')

  const list = messages.list(tid)
  check('落了一条文件消息', list.messages.length === 1)
  check('kind 是 file', list.messages[0].kind === 'file')
  check('带了大小', typeof list.messages[0].payload.size === 'number' && list.messages[0].payload.size > 0)
  check('文件名正确', list.messages[0].payload.name === '交付说明.md')

  const token = list.messages[0].payload.url.split('/artifacts/')[1]
  const hit = artifacts.resolve(tid, token)
  check('能解析到文件', Boolean(hit))
}

console.log('\n== 发文件：QQ 走 uploadGroupFile ==')
{
  const before = botCalls.length
  const src = join(tmp, 'pkg.zip')
  writeFileSync(src, 'ZIPDATA')
  await transport.sendFile('123456', src, 'pkg.zip')
  check('bot 收到了', botCalls.length === before + 1)
  check('用的是上传接口', botCalls.at(-1).kind === 'file')
  check('带了原路径', botCalls.at(-1).path === src)
  check('带了文件名', botCalls.at(-1).name === 'pkg.zip')
}

console.log('\n== 发文件：源文件不存在时退化成提示，不抛错 ==')
{
  const tid = newThreadId()
  let threw = false
  try {
    await transport.sendFile(tid, join(tmp, '根本不存在.bin'), 'x.bin')
  } catch {
    threw = true
  }
  check('没有抛异常（否则整个回合会被带走）', threw === false)
  const list = messages.list(tid)
  check('落了一条说明', list.messages.length === 1)
  check('说明里提到发送失败', /失败/.test(list.messages[0].payload.text ?? ''))
}

console.log('\n== 结构化事件：只对 App 落库 ==')
{
  const tid = newThreadId()
  transport.event(tid, 'stage', { stage: '开发', status: '进行中' })
  const list = messages.list(tid)
  check('落了一条', list.messages.length === 1)
  check('kind 是 stage', list.messages[0].kind === 'stage')
  check('带了阶段名', list.messages[0].payload.stage === '开发')

  const before = botCalls.length
  transport.event('123456', 'stage', { stage: '开发', status: '进行中' })
  check('QQ 群不落库也不调 bot', botCalls.length === before && messages.list('123456').messages.length === 0)
}

console.log('\n== 落库失败时不影响发送主流程 ==')
{
  // 用一个必然写失败的 store 验证「日志里能看到，但流程不断」
  const brokenMessages = {
    append: () => {
      throw new Error('磁盘满了')
    },
    list: () => ({ messages: [], lastSeq: 0 }),
  }
  const t2 = createTransport({ bot, messages: brokenMessages, artifacts, log: (m) => logs.push(m) })
  let threw = false
  try {
    await t2.sendText(newThreadId(), '会写失败的消息')
  } catch {
    threw = true
  }
  check('不抛异常', threw === false)
  check('记了日志', logs.some((l) => /落库失败/.test(l)), JSON.stringify(logs.slice(-2)))
}

console.log('\n== 消息里没有跨会话污染 ==')
{
  const a = newThreadId()
  const b = newThreadId()
  await transport.sendText(a, '属于 A')
  await transport.sendText(b, '属于 B')
  check('A 只有自己的', messages.list(a).messages.length === 1 && messages.list(a).messages[0].payload.text === '属于 A')
  check('B 只有自己的', messages.list(b).messages.length === 1 && messages.list(b).messages[0].payload.text === '属于 B')
}

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
