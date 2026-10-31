/**
 * 健壮性测试：NapCat 没起来 / 中途断开时，bridge 必须活着并自愈。
 *
 *   node test/resilience.js
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

// 不要写死 /tmp：Windows 上没有这个目录，用系统临时目录
const TMP = join(tmpdir(), 'qqrs-resilience')
mkdirSync(TMP, { recursive: true })

// config 现在强制要求有效的 requirement-spec skill，测试自己造一个
const skillDir = join(TMP, 'skills', 'requirement-spec')
mkdirSync(skillDir, { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: requirement-spec\ndescription: test fixture\n---\n')

const cfg = (ws) => {
  const p = join(TMP, `cfg-${Date.now()}.json`)
  writeFileSync(
    p,
    JSON.stringify({
      repos: [{ id: 'app', name: 'test', path: TMP }],
      skillDir,
      dshBin: 'dsh',
      profile: 'qqbot',
      bot: { qq: '10000', name: '产品同学' },
      onebot: { ws },
      limits: { maxMessagesPerMinute: 60, chunkChars: 400, maxChunksPerTurn: 12 },
      upload: { enabled: false },
      turnTimeoutMs: 60000,
      // 端口 0 = 系统分配，避免和本机正在跑的 bot 撞车
      panel: { enabled: true, port: 0, publicPort: 0, token: '' },
    }),
  )
  return p
}

// ── 场景 1：NapCat 完全没起，进程不能崩 ──
console.log('\n场景 1：连不上时进程必须存活')
{
  const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), `--config=${cfg('ws://127.0.0.1:1')}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = []
  child.stdout.on('data', (d) => out.push(d.toString()))
  child.stderr.on('data', (d) => out.push('[err] ' + d.toString()))

  await sleep(2500)
  check('进程还活着', child.exitCode === null, `退出码 ${child.exitCode}`)
  const text = out.join('')
  check('没有抛异常栈', !text.includes('throw err') && !text.includes('Error: OneBot WebSocket'), '')
  check('给出了失败原因', /连不上 OneBot.*(端口|超时|主机)/.test(text), text.slice(-300))
  check('给出了 NapCat 配置提示', text.includes('WebSocket 服务端'), '')

  child.kill('SIGKILL')
  await sleep(200)
}

// ── 场景 2：先断后连，bridge 要能自愈 ──
console.log('\n场景 2：NapCat 后启动，bridge 要能自愈')
{
  const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), `--config=${cfg('ws://127.0.0.1:39998')}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = []
  child.stdout.on('data', (d) => out.push(d.toString()))
  child.stderr.on('data', (d) => out.push('[err] ' + d.toString()))

  await sleep(1500)
  check('先处于未连接状态', !out.join('').includes('已连接 OneBot'))

  // 现在起一个 mock 在约好的端口上
  const mock = await startMockOneBot({ port: 39998, selfId: 10000 })
  // 等重连（默认 3 秒间隔）
  let connected = false
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    if (out.join('').includes('已连接 OneBot')) {
      connected = true
      break
    }
  }
  check('后启动的 NapCat 被连上', connected, out.join('').slice(-400))
  check('自动拉到群列表', out.join('').includes('测试需求群'), '')

  child.kill('SIGKILL')
  await mock.close()
  await sleep(200)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
