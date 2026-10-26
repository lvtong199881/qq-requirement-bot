/**
 * 面板接口分层：
 *   /api/board              需求大盘（群维度）
 *   /api/instances          实例页（进程维度）
 *   /api/instances?pid=xxx  单个进程的完整状态
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

const FULL_GROUP = {
  groupId: '100',
  reqId: 'demo',
  stage: '开发',
  stageStatus: '进行中',
  stageStartedAt: Date.now(),
  stages: [{ name: '开发', status: '进行中' }],
}
const SLIM_GROUP = {
  groupId: '100',
  reqId: 'demo',
  stage: '开发',
  stageStatus: '进行中',
}

// ── 假 bridge：记录被问了哪些路径，按路径返回不同体量的数据 ──
const asked = []
const fakeBridge = createServer((req, res) => {
  asked.push(req.url)
  const payload = req.url.startsWith('/api/summary')
    ? {
        instance: { pid: process.pid, port: 0 },
        config: { model: 'fake-model' },
        onebot: { url: 'ws://x', connected: true },
        resources: { rssMb: 10, heapMb: 5 },
        groups: [SLIM_GROUP],
        slim: true,
      }
    : req.url.startsWith('/api/status')
      ? {
          instance: { pid: process.pid, port: 0 },
          config: { model: 'fake-model' },
          onebot: { url: 'ws://x', connected: true },
          resources: { rssMb: 10, heapMb: 5 },
          groups: [FULL_GROUP],
          recentEvents: [{ level: 'info', text: 'something happened' }],
          full: true,
        }
      : { logs: [{ level: 'info', text: 'log line' }] }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
})

await new Promise((r) => fakeBridge.listen(0, '127.0.0.1', r))
const bridgePort = fakeBridge.address().port

const repoRoot = mkdtempSync(join(tmpdir(), 'panel-api-'))
mkdirSync(join(repoRoot, '.instances'), { recursive: true })
writeFileSync(
  join(repoRoot, '.instances', `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, port: bridgePort, startedAt: Date.now() }),
  'utf8',
)

const panel = await startPanel({ repoRoot, port: 0 })
const base = `http://127.0.0.1:${panel.address().port}`

console.log('\n== 需求大盘 /api/board ==')
{
  asked.length = 0
  const body = await (await fetch(`${base}/api/board`)).json()
  const row = body.rows?.[0] ?? {}
  check('按群维度摊平', Array.isArray(body.rows) && body.rows.length === 1)
  check('行里带所属进程 pid', row.pid === process.pid)
  check('行里带群与需求字段', row.groupId === '100' && row.reqId === 'demo')
  check('走的是 /api/summary', asked.every((u) => u.startsWith('/api/summary')))
  check('不含事件流', row.recentEvents === undefined)
  check('不含阶段表', row.stages === undefined)
  check('不含进程配置（那是实例页的事）', row.config === undefined && row.resources === undefined)
  check('带告警计数', typeof body.alerts === 'number' && body.alerts === 0)
}

console.log('\n== 实例页 /api/instances ==')
{
  asked.length = 0
  const body = await (await fetch(`${base}/api/instances`)).json()
  const inst = body.instances?.[0] ?? {}
  check('按进程维度返回', Array.isArray(body.instances) && body.instances.length === 1)
  check('带进程配置与资源', inst.config?.model === 'fake-model' && inst.resources?.rssMb === 10)
  check('走的是 /api/summary', asked.every((u) => u.startsWith('/api/summary')))
  check('不含事件流', inst.recentEvents === undefined)
  check('不含阶段表', inst.groups?.[0]?.stages === undefined)
  check('带群数量用于汇总', Array.isArray(inst.groups) && inst.groups.length === 1)
}

console.log('\n== 详情 /api/instances?pid= ==')
{
  asked.length = 0
  const body = await (await fetch(`${base}/api/instances?pid=${process.pid}`)).json()
  check('返回完整状态', body.full === true)
  check('走的是 /api/status', asked.some((u) => u.startsWith('/api/status')))
  check('带完整事件流', Array.isArray(body.recentEvents) && body.recentEvents.length === 1)
  check('带阶段表', Array.isArray(body.groups?.[0]?.stages))
  check('带阶段开始时间', typeof body.groups?.[0]?.stageStartedAt === 'number')
}

console.log('\n== 边界 ==')
{
  const r = await fetch(`${base}/api/instances?pid=999999`)
  check('不存在的 pid 返回 404', r.status === 404)
  const body = await r.json()
  check('给出可读错误', typeof body.error === 'string' && body.error.length > 0)

  const r2 = await fetch(`${base}/api/instances/123`)
  check('旧的路径式详情已移除', r2.status === 404)
}

await new Promise((r) => panel.close(r))
await new Promise((r) => fakeBridge.close(r))
rmSync(repoRoot, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
