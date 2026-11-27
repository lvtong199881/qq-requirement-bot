/**
 * 自检：验证本机这条链路能不能跑通，不连任何外部协议端。
 *
 *   node src/doctor.js            检查配置 / 密钥 / dsh / App API
 *   node src/doctor.js --turn     额外真跑一个回合（会消耗 token）
 */
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { loadConfig, resolveModelEnv } from './config.js'
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
  ok(`项目目录：${config.projectDir ?? '（未配置，接需求前先填 repos）'}`)
  ok(`profile：${config.profile}｜bot 昵称：${config.bot.name}`)

  if (config.repos?.length) {
    for (const r of config.repos) {
      if (!existsSync(r.path)) fail(`仓库 ${r.id} 的路径不存在：${r.path}`)
    }
    ok(`仓库：${config.repos.map((r) => r.id).join('、')}`)
  }

  if (config.api?.enabled !== true) {
    // App 是唯一入口，关掉等于整个服务没有前端
    fail('api.enabled 不是 true——App 会连不上')
  } else {
    ok(`App API：${config.api.host}:${config.api.port}`)
    if (config.api.host === '0.0.0.0' || config.api.host === '::') {
      warn('App API 监听在 0.0.0.0，同网络的人都能访问')
    }
  }
} catch (err) {
  fail(err.message)
  console.log('\n配置不通过，后面的检查跳过。\n')
  process.exit(1)
}

console.log('\n2. 模型凭证')
// 官方 DeepSeek 和第三方通道都认：profile 决定用哪个 provider，
// 这里只确认至少有一个能用的 key。
const envKeys = resolveModelEnv(config)
const keyNames = Object.keys(envKeys)
const apiKey = envKeys[keyNames[0]]
if (keyNames.length && apiKey) {
  ok(`可用凭证：${keyNames.join('、')}`)
} else {
  const wanted = config.model?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  fail(`找不到模型凭证：设 ${wanted}（也认 DEEPSEEK_API_KEY / OPENCODE_GO_API_KEY）`)
}

console.log('\n3. dsh 可执行')
const which = await new Promise((resolve) => {
  import('node:child_process').then(({ exec }) => {
    // 用 exec（走 shell）而不是 execFile + shell：路径含空格时
    // （...\DeepSeek Harness\...）必须靠引号包住整条命令。
    // 但裸命令名（如 dsh，靠 PATH 解析）不能加引号：cmd 会把 "dsh" 当成文件路径，
    // 报 9009 找不到，误判成 dsh 没装。只有含路径分隔符的才加引号。
    const bin = /[\\/]/.test(config.dshBin) ? `"${config.dshBin}"` : config.dshBin
    exec(`${bin} --version`, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim())
    })
  })
})
if (which) ok(`${config.dshBin} --version → ${which}`)
else warn(`无法执行 ${config.dshBin}，确认在 PATH 里（headless 执行会用到）`)

console.log('\n4. App API 端口')
// 只探端口占不占用，不发请求：这里还没启动，真起了 bridge 之后端口当然是被占的，
// 所以这条只在「端口已被别的进程占着」时才有价值，用 warn 提示而不是 fail。
const portFree = await new Promise((resolve) => {
  const srv = createServer()
  srv.once('error', () => resolve(false))
  srv.once('listening', () => {
    srv.close(() => resolve(true))
  })
  srv.listen(config.api?.port ?? 7881, config.api?.host === '0.0.0.0' ? undefined : config.api?.host)
})
if (portFree) ok(`端口 ${config.api?.port} 可用`)
else warn(`端口 ${config.api?.port} 已被占用——bridge 已经在跑？还是别的程序占了`)

if (runRealTurn) {
  console.log('\n5. 真实回合（会消耗 token）')
  const started = Date.now()
  const res = await runTurn({
    dshBin: config.dshBin,
    profile: config.profile,
    projectDir: config.projectDir || process.cwd(),
    prompt: '只回答两个字：收到。不要调用任何工具，也不要输出 [[WAITING]]。',
    env: { ...process.env, ...(apiKey ? { [keyNames[0]]: apiKey } : {}) },
    timeoutMs: 120_000,
    onEvent: () => {},
  })
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (res.exitCode === 0 && res.finalText) {
    ok(`${secs}s 内返回：${res.finalText.slice(0, 80)}`)
    ok(`sessionId：${res.sessionId}`)
  } else {
    fail(`回合失败（退出码 ${res.exitCode}，超时=${res.timedOut}）`)
    const tail = String(res.stderr ?? '').split('\n').slice(-5).join('\n')
    if (tail) console.log(tail)
    // 这个错跟代码无关，是 dsh 那边没给 provider 注册适配器。
    // 照着报错去翻源码要花很久，这里直接把改法写出来。
    if (/NO_ADAPTER|no adapter registered/.test(`${tail}${res.finalText ?? ''}`)) {
      console.log(
        [
          '',
          `  这不是 bridge 的问题：dsh 的 profile 里没有注册 ${config.model?.provider ?? '这个 provider'}。`,
          `  在 ~/.dsh/profiles/${config.profile}/cordis.patch.yml 加上：`,
          '',
          '    - id: llm-pi-ai',
          '      name: "@deepseek-ai/dsh-llm-pi-ai"',
          '      config:',
          '        providers:',
          `          ${config.model?.provider ?? 'provider'}:`,
          `            apiKeyEnv: ${config.model?.apiKeyEnv ?? 'API_KEY'}`,
          '',
          '  改完不用重启任何东西，下一个回合就会用上。',
        ].join('\n'),
      )
    }
  }
}

console.log(
  failed === 0
    ? '\n自检通过。可以 `node src/index.js` 启动 bridge 了。\n'
    : `\n自检发现 ${failed} 个问题，先修掉再启动。\n`,
)
process.exit(failed === 0 ? 0 : 1)
