// 一次性发布当前隧道地址到发现通道。给 tunnel-keepalive.ps1 调用，
// 也可手动跑：
//   node scripts/publish-endpoint.js https://xxx.trycloudflare.com [更多候选...]
//
// instanceId 从 .state/instance-id 读（bridge 启动时生成）；配置里的
// discovery.rawUrl 决定发到哪里。失败只打日志，exit 1。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishEndpoint } from '../src/endpoint-publisher.js'

const urls = process.argv.slice(2).filter((u) => /^https?:\/\//.test(u))
if (!urls.length) {
  console.error('[discovery] 用法：node scripts/publish-endpoint.js <url1> [url2 ...]')
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(join(process.cwd(), 'bot.config.json'), 'utf8'))
const rawUrl = cfg.discovery?.rawUrl ?? ''
if (!rawUrl) {
  console.error('[discovery] bot.config.json 没配 discovery.rawUrl，跳过发布')
  process.exit(1)
}

let instanceId = ''
try {
  instanceId = readFileSync(join(process.cwd(), '.state', 'instance-id'), 'utf8').trim()
} catch {
  // bridge 还没用新代码启动过（instance-id 是它启动时生成的）。
  // 没有指纹就发不了，等 bridge 重启后由它自己发首发。
  console.error('[discovery] .state/instance-id 不存在（bridge 还没跑过新代码），跳过发布')
  process.exit(1)
}

publishEndpoint({
  rawUrl,
  giteeToken: cfg.discovery?.giteeToken ?? '',
  instanceId,
  urls,
  log: (m) => console.log(m),
})
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(`[discovery] 发布异常：${err?.message ?? err}`)
    process.exit(1)
  })
