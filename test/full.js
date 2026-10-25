/**
 * 全链路测试：真的把 src/index.js 当进程跑起来，注入群消息，
 * 看它是否 spawn dsh、是否把结果发回群。
 *
 *   node test/full.js          真跑 dsh（消耗 token）
 *   node test/full.js --no-llm 不发真实需求，只验证握手与路由
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockOneBot } from './mock-onebot.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const noLlm = process.argv.includes('--no-llm')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const mock = await startMockOneBot({ port: 0, selfId: 10000 })

const tmpProject = mkdtempSync(join(tmpdir(), 'qqrs-full-'))
mkdirSync(join(tmpProject, 'docs', 'requirements'), { recursive: true })

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
      upload: { enabled: false, maxFiles: 4, maxFileMB: 20 },
      turnTimeoutMs: 240_000,
      verbose: true,
    },
    null,
    2,
  ),
)

console.log('\n启动 bridge 进程…')
const logs = []
const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), `--config=${configPath}`], {
  cwd: ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => {
  const s = d.toString()
  logs.push(s)
  process.stdout.write('    ' + s.replace(/\n(?=.)/g, '\n    '))
})
child.stderr.on('data', (d) => {
  const s = d.toString()
  logs.push('[err] ' + s)
  process.stdout.write('    [err] ' + s)
})

// 等 bridge 连上 mock
await sleep(1500)
check('bridge 进程存活', child.exitCode === null)

if (noLlm) {
  console.log('\n--no-llm：只验证进程与握手')
  check('日志显示已连接', logs.join('').includes('已连接 OneBot'))
  // 发一条会被忽略的消息（非 @）
  mock.sendGroupAt({ groupId: '123456', text: '这条没 @ 你', atBot: false })
  await sleep(500)
  check('未 @ 的消息被忽略', !mock.sentTexts().length)
  // 发 @ 的「停」，验证指令通道
  mock.sendGroupAt({ groupId: '123456', text: '停' })
  await sleep(800)
  check('「停」有回复', mock.sentTexts().some((t) => t.includes('没有在跑')))
} else {
  console.log('\n注入真实需求（会跑 dsh）…')
  mock.sendGroupAt({
    groupId: '123456',
    text: '只回答四个字：产品同学你好。不要调用任何工具。',
  })

  // 最多等 3 分钟
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await sleep(2000)
    if (mock.sentTexts().length >= 2) break
    if (child.exitCode !== null) break
  }

  const texts = mock.sentTexts()
  console.log('\n  群收到的消息：')
  texts.forEach((t, i) => console.log(`    [${i}] ${String(t).slice(0, 120).replace(/\n/g, ' ⏎ ')}`))

  check('群收到了回复', texts.length > 0, `共 ${texts.length} 条`)
  check('回复内容正确', texts.some((t) => String(t).includes('产品同学你好')), '未找到期望文本')
  check('回复带 bot 昵称前缀', texts.some((t) => String(t).includes('产品同学')), '')
  check('没有残留闸门标记', !texts.some((t) => String(t).includes('[[')), '标记漏到群里了')
  check('状态文件已落盘', (() => {
    try {
      const st = JSON.parse(readFileSync(join(ROOT, '.state', 'group-123456.json'), 'utf8'))
      return !!st.sessionId
    } catch {
      return false
    }
  })(), 'sessionId 未持久化')
}

child.kill('SIGTERM')
await sleep(500)
if (child.exitCode === null) child.kill('SIGKILL')
await mock.close()

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
