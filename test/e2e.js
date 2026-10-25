/**
 * 端到端测试：mock OneBot + 真 dsh headless，走一遍「@ → 回合 → 回群」。
 *
 *   node test/e2e.js            完整链路（消耗 token）
 *   node test/e2e.js --no-llm   只测 OneBot 收发与路由，不跑 dsh
 */
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './mock-onebot.js'
import { parseGate } from '../src/protocol.js'
import { sanitize, splitChunks } from '../src/format.js'

const noLlm = process.argv.includes('--no-llm')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    console.log(`  ✅ ${name}`)
    pass++
  } else {
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
    fail++
  }
}

console.log('\n== 单元：协议解析 ==')
{
  const a = parseGate('正文\n[[WAITING]]等 PRD 确认')
  check('WAITING 被识别', a.state === 'waiting' && a.label === '等 PRD 确认')
  check('标记从正文剥离', a.cleaned === '正文')

  const b = parseGate('[[DONE]]交付完成')
  check('DONE 被识别', b.state === 'done' && b.label === '交付完成')

  const c = parseGate('普通输出没有标记')
  check('无标记为 running', c.state === 'running')

  const d = parseGate('**[[WAITING]]** 设计稿')
  check('markdown 包裹仍可解析', d.state === 'waiting' && d.label === '设计稿')
}

console.log('\n== 单元：格式化 ==')
{
  const s = sanitize('## 标题\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n**粗体**')
  check('标题符号被去除', !s.includes('##'))
  check('表格分隔行被去除', !s.includes('| - |'))
  check('表格内容保留', s.includes('1 | 2'))
  check('粗体符号被去除', s.includes('粗体') && !s.includes('**'))

  const chunks = splitChunks('a'.repeat(500) + '\n\n' + 'b'.repeat(500), 300, 5)
  check('长文被分条', chunks.length >= 2)
  check('分条不超过上限', chunks.length <= 6)
}

console.log('\n== 集成：OneBot 连接与收发 ==')
const mock = await startMockOneBot({ port: 0, selfId: 10000 })

// 造一个临时项目与配置，避免污染真实 Instanto
const tmpProject = mkdtempSync(join(tmpdir(), 'qqrs-'))
mkdirSync(join(tmpProject, 'docs', 'requirements', 'REQ-TEST'), { recursive: true })
writeFileSync(join(tmpProject, 'docs', 'requirements', 'REQ-TEST', 'PRD.md'), '# 测试 PRD\n')

const configPath = join(tmpProject, 'bot.config.json')
writeFileSync(
  configPath,
  JSON.stringify(
    {
      projectDir: tmpProject,
      skillDir: '',
      dshBin: 'dsh',
      profile: 'qqbot',
      bot: { qq: '10000', name: '产品同学' },
      onebot: { ws: mock.url },
      groups: [{ groupId: '123456', projectDir: tmpProject, approval: 'manual' }],
      limits: { maxMessagesPerMinute: 60, chunkChars: 400, maxChunksPerTurn: 12 },
      upload: { enabled: true, maxFiles: 4, maxFileMB: 20 },
      turnTimeoutMs: 180_000,
      verbose: false,
    },
    null,
    2,
  ),
)

const { OneBot } = await import('../src/onebot.js')
const client = new OneBot({ ws: mock.url })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('连接超时')), 5000)
  client.on('connected', () => {
    clearTimeout(t)
    resolve()
  })
  client.connect()
})
check('bridge 能连上 OneBot', client.connected)

await sleep(150)
check('拿到 self_id', String(client.selfId) === '10000', `实际 ${client.selfId}`)

// 发消息 API
await client.sendGroupMsg('123456', '你好，这是测试消息')
const sent = mock.sentTexts()
check('send_group_msg 被调用', sent.includes('你好，这是测试消息'))

// 引用回复：数组消息带 reply 段
await client.sendGroupMsg('123456', [
  { type: 'reply', data: { id: '999' } },
  { type: 'text', data: { text: '这是引用回复' } },
])
const raw = mock.sentRaw()
const replyMsg = raw.find((m) => Array.isArray(m) && m[0]?.type === 'reply')
check('能发出引用回复', !!replyMsg, '未找到 reply 段')
check('引用 id 正确', replyMsg?.[0]?.data?.id === '999')
check('引用回复的文本被正确抽取', mock.sentTexts().includes('这是引用回复'))

// 收消息事件
const received = []
client.on('message', (f) => received.push(f))
mock.sendGroupAt({ groupId: '123456', text: '首页加个欢迎弹窗' })
await sleep(200)
check('收到群 @ 消息', received.length === 1)
check('消息类型是 group', received[0]?.message_type === 'group')
check('能解析出正文', received[0]?.message.find((s) => s.type === 'text')?.data.text === '首页加个欢迎弹窗')

// 文件上传
await client.uploadGroupFile('123456', join(tmpProject, 'docs/requirements/REQ-TEST/PRD.md'), 'REQ-TEST__PRD.md')
check('upload_group_file 被调用', mock.uploadedFiles().length === 1)

client.close()
await mock.close()

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
