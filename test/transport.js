/**
 * 传输层测试。
 *
 * 这一层现在只有一条路：App 通道。历史上的 QQ 分流（群号 vs threadId 判定、
 * base64 内联图片、uploadGroupFile 上传）已经随 OneBot 一起删掉了，对应
 * 的二十多条断言也一并删掉——留着测不存在的分支只会让后来人以为还有 QQ。
 *
 * 会话类型判定（isAppThread）挪到 src/api/threads.js 了，它的测试在
 * test/app-api.js 里，因为那边本来就要造 threadId。
 *
 *   node test/transport.js
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageStore } from '../src/store/messages.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { createTransport } from '../src/transport/transport.js'
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

const logs = []
const transport = createTransport({ messages, artifacts, log: (m) => logs.push(m) })

console.log('\n== 发文本 ==')
{
  const tid = newThreadId()
  await transport.sendText(tid, '需求澄清通过了')
  const list = messages.list(tid)
  check('落了一条', list.messages.length === 1)
  check('角色是 bot', list.messages[0].role === 'bot')
  check('kind 是 text', list.messages[0].kind === 'text')
  check('文本原样', list.messages[0].payload.text === '需求澄清通过了')
  check('seq 从 1 开始', list.messages[0].seq === 1)
}

console.log('\n== 连发多条按顺序落库 ==')
{
  const tid = newThreadId()
  await transport.sendText(tid, '第一条')
  await transport.sendText(tid, '第二条')
  const list = messages.list(tid)
  check('两条都在', list.messages.length === 2)
  check('顺序正确', list.messages[0].payload.text === '第一条' && list.messages[1].payload.text === '第二条')
  check('seq 递增', list.messages[0].seq < list.messages[1].seq)
}

console.log('\n== 发图片 ==')
{
  const tid = newThreadId()
  await transport.sendImage(tid, { buffer: Buffer.from('PNGDATA'), name: '首页.png' })

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

console.log('\n== 结构化事件 ==')
{
  const tid = newThreadId()
  transport.event(tid, 'stage', { stage: '开发', status: '进行中' })
  const list = messages.list(tid)
  check('落了一条', list.messages.length === 1)
  check('kind 是 stage', list.messages[0].kind === 'stage')
  check('带了阶段名', list.messages[0].payload.stage === '开发')
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
  const t2 = createTransport({ messages: brokenMessages, artifacts, log: (m) => logs.push(m) })
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

console.log('\n== 文件系统里只有 thread 自己的产物 ==')
{
  const tid = newThreadId()
  await transport.sendImage(tid, { buffer: Buffer.from('X'), name: 'a.png' })
  const other = newThreadId()
  await transport.sendImage(other, { buffer: Buffer.from('Y'), name: 'b.png' })
  const aFiles = artifacts.listDir ?? null
  const tokenA = messages.list(tid).messages[0].payload.url.split('/artifacts/')[1]
  const tokenB = messages.list(other).messages[0].payload.url.split('/artifacts/')[1]
  check('A 的 token 在 B 的会话里解析不到', artifacts.resolve(other, tokenA) === null, String(aFiles))
  check('各自的 token 都能解析', Boolean(artifacts.resolve(tid, tokenA)) && Boolean(artifacts.resolve(other, tokenB)))
}

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
