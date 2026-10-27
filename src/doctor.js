/**
 * 自检：不连 QQ，只验证本机这条链路能不能跑通。
 *
 *   node src/doctor.js            检查配置 / 密钥 / skill / dsh / OneBot 连通性
 *   node src/doctor.js --turn     额外真跑一个回合（会消耗 token）
 */
import { existsSync } from 'node:fs'
import { loadConfig, resolveApiKey } from './config.js'
import { runTurn } from './runner.js'

const configPath = process.argv.find((a) => a.startsWith('--config='))?.slice(9)
const runRealTurn = process.argv.includes('--turn')

const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m) => console.log(`  ❌ ${m}`)
const warn = (m) => console.log(`  ⚠️  ${m}`)

let failed = 0
const fail = (m) => {
  bad(m)
  failed++
}

console.log('\n1. 配置')
let config
try {
  config = loadConfig(configPath)
  ok(`配置文件：${config.configPath}`)
  ok(`项目目录：${config.projectDir}`)
  ok(`skill 目录（动态解析）：${config.skillDir}`)
  ok(`profile：${config.profile}｜bot 昵称：${config.bot.name}`)
  if (!config.bot.qq) warn('bot.qq 未填（不影响接收消息，但填了能识别自发消息）')

  const mode = config.groupPolicy.mode
  if (mode === 'auto') {
    ok(`群策略：auto —— 拉进哪个群就服务哪个群，不用填群号`)
  } else if (mode === 'allowlist') {
    ok(`群策略：allowlist —— 只服务 ${config.groups.length} 个群`)
    if (!config.groups.length) fail('allowlist 模式但 groups 为空')
  } else {
    fail('群策略：deny —— 不会服务任何群')
  }
  for (const g of config.groups) {
    if (!existsSync(g.projectDir)) fail(`群 ${g.groupId} 的项目目录不存在：${g.projectDir}`)
  }
} catch (err) {
  fail(err.message)
  console.log('\n配置不通过，后面的检查跳过。\n')
  process.exit(1)
}

console.log('\n2. 密钥')
const key = resolveApiKey()
if (key) ok(`DEEPSEEK_API_KEY 可用（长度 ${key.length}）`)
else fail('找不到 DEEPSEEK_API_KEY：export 一下，或在 DSH Web GUI 保存模型密钥')

console.log('\n3. skill')
if (existsSync(`${config.skillDir}/SKILL.md`)) ok('SKILL.md 存在')
else fail(`缺少 ${config.skillDir}/SKILL.md`)

console.log('\n4. dsh 可执行')
const which = await new Promise((resolve) => {
  import('node:child_process').then(({ execFile }) => {
    execFile(config.dshBin, ['--version'], (err, stdout) => {
      resolve(err ? null : (stdout || '').trim())
    })
  })
})
if (which) ok(`${config.dshBin} --version → ${which}`)
else warn(`无法执行 ${config.dshBin}，确认在 PATH 里（headless 执行会用到）`)

console.log('\n5. OneBot 连通性')
const wsUrl = config.onebot.ws
const reachable = await new Promise((resolve) => {
  let settled = false
  const done = (v) => {
    if (!settled) {
      settled = true
      resolve(v)
    }
  }
  try {
    const ws = new WebSocket(
      config.onebot.token
        ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(config.onebot.token)}`
        : wsUrl,
    )
    const timer = setTimeout(() => {
      ws.close()
      done(false)
    }, 4000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      ws.close()
      done(true)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      done(false)
    })
  } catch {
    done(false)
  }
})
if (reachable) {
  ok(`能连上 ${wsUrl}`)
} else {
  // 连不上时给出具体原因，别只丢一句「连不上」
  const { explainProbe } = await import('./onebot.js')
  let probe = 'unknown'
  try {
    const net = await import('node:net')
    const u = new URL(wsUrl)
    probe = await new Promise((resolve) => {
      const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) })
      const t = setTimeout(() => {
        sock.destroy()
        resolve('timeout')
      }, 2000)
      sock.on('connect', () => {
        clearTimeout(t)
        sock.destroy()
        resolve('open')
      })
      sock.on('error', (e) => {
        clearTimeout(t)
        resolve(e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ENOTFOUND' ? 'unreachable' : 'unknown')
      })
    })
  } catch {
    /* keep unknown */
  }
  warn(explainProbe(probe, wsUrl))
  console.log('     —— 不影响 --turn 自检，但启动 bridge 前必须解决')
}

if (runRealTurn) {
  console.log('\n6. 真实回合（会消耗 token）')
  const group = config.groups[0]
  const started = Date.now()
  const res = await runTurn({
    dshBin: config.dshBin,
    profile: config.profile,
    projectDir: group?.projectDir || config.projectDir,
    prompt: '只回答两个字：收到。不要调用任何工具，也不要输出 [[WAITING]]。',
    env: { ...process.env, DEEPSEEK_API_KEY: key },
    timeoutMs: 120_000,
    onEvent: () => {},
  })
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (res.exitCode === 0 && res.finalText) {
    ok(`${secs}s 内返回：${res.finalText.slice(0, 80)}`)
    ok(`sessionId：${res.sessionId}`)
  } else {
    fail(`回合失败（退出码 ${res.exitCode}，超时=${res.timedOut}）`)
    if (res.stderr) console.log(res.stderr.split('\n').slice(-5).join('\n'))
  }
}

console.log(
  failed === 0
    ? '\n自检通过。可以 `node src/index.js` 启动 bridge 了。\n'
    : `\n自检发现 ${failed} 个问题，先修掉再启动。\n`,
)
process.exit(failed === 0 ? 0 : 1)
