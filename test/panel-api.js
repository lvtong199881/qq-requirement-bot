/**
 * 面板接口的分层：列表只拿精简数据，完整数据单独一个接口。
 *   node test/panel-api.js
 *
 * 用一个假的 bridge 顶替真实实例，不连 QQ、不跑 dsh。
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startPanel } from '../src/panel.js'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

// ── 假 bridge：记录被问了哪些路径，按路径返回不同体量的数据 ──
const asked = []
const fakeBridge = createServer((req, res) => {
  asked.push(req.url)
  const payload = req.url.startsWith('/api/summary')
    ? {
        instance: { pid: process.pid, port: 0 },
        groups: [{ groupId: '100', reqId: 'demo', stage: '开发', stageStatus: '进行中' }],
        slim: true,
      }
    : req.url.startsWith('/api/status')
      ? {
          instance: { pid: process.pid, port: 0 },
          groups: [
            {
              groupId: '100',
              reqId: 'demo',
              stage: '开发',
              stageStatus: '进行中',
              stageStartedAt: Date.now(),
              stages: [{ name: '开发', status: '进行中' }],
            },
          ],
          recentEvents: [{ level: 'info', text: 'something happened' }],
          full: true,
        }
      : { logs: [{ level: 'info', text: 'log line' }] }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
})

await new Promise((r) => fakeBridge.listen(0, '127.0.0.1', r))
const bridgePort = fakeBridge.address().port

// 让面板通过 .instances/<pid>.json 发现这个「实例」
const repoRoot = mkdtempSync(join(tmpdir(), 'panel-api-'))
mkdirSync(join(repoRoot, '.instances'), { recursive: true })
writeFileSync(
  join(repoRoot, '.instances', `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, port: bridgePort, startedAt: Date.now() }),
  'utf8',
)

const panel = await startPanel({ repoRoot, port: 0 })
const panelPort = panel.address().port
const base = `http://127.0.0.1:${panelPort}`

console.log('\n== 列表接口 /api/instances ==')
{
  const r = await fetch(`${base}/api/instances`)
  const body = await r.json()
  const inst = body.instances?.[0] ?? {}
  check('返回 200', r.status === 200)
  check('拿到实例', !!body.instances?.length)
  check('走的是 /api/summary', asked.some((u) => u.startsWith('/api/summary')))
  check('不包含完整事件流', inst.recentEvents === undefined)
  check('不包含阶段表', inst.groups?.[0]?.stages === undefined)
  check('列表需要的字段还在', inst.groups?.[0]?.reqId === 'demo' && inst.groups?.[0]?.stageStatus === '进行中')
}

console.log('\n== 详情接口 /api/instances/:pid ==')
{
  asked.length = 0
  const r = await fetch(`${base}/api/instances/${process.pid}`)
  const body = await r.json()
  check('返回 200', r.status === 200)
  check('走的是 /api/status', asked.some((u) => u.startsWith('/api/status')))
  check('带完整事件流', Array.isArray(body.recentEvents) && body.recentEvents.length === 1)
  check('带阶段表', Array.isArray(body.groups?.[0]?.stages) && body.groups[0].stages.length === 1)
  check('带阶段开始时间', typeof body.groups?.[0]?.stageStartedAt === 'number')
}

console.log('\n== 不存在的实例 ==')
{
  const r = await fetch(`${base}/api/instances/999999`)
  check('返回 404', r.status === 404)
  const body = await r.json()
  check('给出可读错误', typeof body.error === 'string' && body.error.length > 0)
}

// 收尾
await new Promise((r) => panel.close(r))
await new Promise((r) => fakeBridge.close(r))
rmSync(repoRoot, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
