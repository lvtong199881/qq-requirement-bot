/**
 * 回合进行中插话，回合结束后必须补跑。
 *
 * 真实事故：一个回合跑了 31 分钟，用户中途发的两条「继续」进了队列，
 * 回合结束后两条都没执行，日志里也没有任何痕迹——群里看着就是 bot 没反应。
 * 这里用假 dsh 复现该场景，确保队列一定被消费、且失败时有日志可查。
 *
 *   node test/queue-rerun.js
 */
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockOneBot } from './mock-onebot.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const tmp = mkdtempSync(join(tmpdir(), 'qqrs-rerun-'))
const project = join(tmp, 'project')
mkdirSync(join(project, 'docs', 'requirements'), { recursive: true })

// 假 dsh：每次被调起就往 FAKE_DSH_LOG 追加一行，睡一会儿再吐一个合法事件流。
// 用睡眠模拟「回合要跑一阵」，好让第二条消息插在它中间。
const dshLog = join(tmp, 'dsh-calls.log')
const fakeDsh = join(tmp, 'fake-dsh.mjs')
writeFileSync(
  fakeDsh,
  `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(dshLog)}, 'call\\n')
process.stdin.resume()
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'fake-session' }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'final', text: '做完了 [[DONE]]交付完成' }) + '\\n')
  process.exit(0)
}, ${Number(process.env.FAKE_DSH_DELAY ?? 2500)})
`,
)
chmodSync(fakeDsh, 0o755)

const mock = await startMockOneBot({ port: 0, selfId: 10000 })
const groupId = '123456'

const configPath = join(tmp, 'bot.config.json')
writeFileSync(
  configPath,
  JSON.stringify(
    {
      projectDir: project,
      skillDir: '',
      dshBin: fakeDsh,
      profile: 'qqbot',
      bot: { qq: '10000', name: '产品同学' },
      onebot: { ws: mock.url },
      limits: { maxMessagesPerMinute: 60, chunkChars: 400, maxChunksPerTurn: 12 },
      upload: { enabled: false, maxFiles: 4, maxFileMB: 20 },
      turnTimeoutMs: 60_000,
      heartbeat: { enabled: false },
      verbose: true,
    },
    null,
    2,
  ),
)

const logs = []
const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), `--config=${configPath}`], {
  cwd: ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => logs.push(d.toString()))
child.stderr.on('data', (d) => logs.push('[err] ' + d.toString()))

const waitFor = async (pred, timeoutMs = 20_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true
    await sleep(150)
  }
  return false
}
const calls = () => (existsSync(dshLog) ? readFileSync(dshLog, 'utf8').trim().split('\n').filter(Boolean).length : 0)

try {
  check('bridge 连上 OneBot', await waitFor(() => logs.join('').includes('已连接 OneBot')))

  // 第一条：起一个回合
  mock.sendGroupAt({ groupId, text: '首页加个欢迎弹窗' })
  check('第一回合已开始', await waitFor(() => logs.join('').includes('v2 回合：')))
  check('假 dsh 被调起 1 次', (await waitFor(() => calls() >= 1, 10_000)) && calls() === 1, `实际 ${calls()}`)

  // 第二条：插在回合中途
  mock.sendGroupAt({ groupId, text: '顺便把按钮改成蓝色' })
  const queuedAck = await waitFor(() =>
    mock.sentTexts().some((t) => t.includes('排队') || t.includes('上一回合')),
  )
  check('插话被排队并回执', queuedAck, JSON.stringify(mock.sentTexts().slice(-3)))

  // 第一回合结束后应当自动补跑第二条
  const rerun = await waitFor(() => logs.join('').includes('补跑排队消息'), 25_000)
  check('回合结束后补跑排队消息', rerun)
  check('假 dsh 被调起 2 次', (await waitFor(() => calls() >= 2, 15_000)) && calls() === 2, `实际 ${calls()}`)
  check('日志没有「丢弃」', !logs.join('').includes('排队消息补跑失败'))
} finally {
  if (fail > 0) {
    console.log('\n--- bridge 日志尾部 ---')
    console.log(logs.join('').split('\n').slice(-25).join('\n'))
  }
  child.kill('SIGTERM')
  await sleep(300)
  if (child.exitCode === null) child.kill('SIGKILL')
  await mock.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
