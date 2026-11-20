/**
 * 面板接口分层：
 *   /api/board              需求大盘（群维度）
 *   /api/board/detail       大盘某一行展开（群 + 它所在的进程）
 *   /api/instances          实例页（进程维度）
 *   node test/panel-api.js
 *
 * 用一个假的 bridge 顶替真实实例，不连 QQ、不跑 dsh。
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startPanel } from '../src/ui/panel.js'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const FULL_GROUP = {
  groupId: 'tbd1a2b3c4d5',
  reqId: 'demo',
  stage: '开发',
  stageStatus: '进行中',
  stageStartedAt: Date.now(),
  stages: [{ name: '开发', status: '进行中' }],
}
const SLIM_GROUP = {
  groupId: 'tbd1a2b3c4d5',
  reqId: 'demo',
  stage: '开发',
  stageStatus: '进行中',
}

// ── 假 bridge：记录被问了哪些路径和收到的 body，按路径返回不同体量的数据 ──
const asked = []
let lastPostBody = null
const fakeBridge = createServer(async (req, res) => {
  asked.push(req.url)
  let raw = ''
  for await (const c of req) raw += c
  if (raw) {
    try {
      lastPostBody = JSON.parse(raw)
    } catch {
      lastPostBody = null
    }
  }

  let payload
  if (req.url.startsWith('/api/summary')) {
    payload = {
      instance: { pid: process.pid, port: 0 },
      config: { model: 'fake-model' },
      resources: { rssMb: 10, heapMb: 5 },
      groups: [SLIM_GROUP],
      slim: true,
    }
  } else if (req.url.startsWith('/api/status')) {
    payload = {
      instance: { pid: process.pid, port: 0 },
      config: { model: 'fake-model' },
      resources: { rssMb: 10, heapMb: 5 },
      groups: [FULL_GROUP],
      recentEvents: [{ level: 'info', text: 'something happened' }],
      full: true,
    }
  } else if (req.url.startsWith('/api/threads/')) {
    payload = { ok: true, message: 'done' }
  } else {
    payload = { logs: [{ level: 'info', text: 'log line' }] }
  }

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
writeFileSync(
  join(repoRoot, 'bot.config.json'),
  JSON.stringify({ messageTemplates: {} }, null, 2),
  'utf8',
)

const panel = await startPanel({ repoRoot, port: 0 })
const base = `http://127.0.0.1:${panel.address().port}`

console.log('\n== 需求大盘 /api/board ==')
{
  asked.length = 0
  const body = await (await fetch(`${base}/api/board`)).json()
  const row = body.rows?.[0] ?? {}
  check('按会话维度摊平', Array.isArray(body.rows) && body.rows.length === 1)
  check('行里带所属进程 pid', row.pid === process.pid)
  check('行里带会话与需求字段', row.groupId === 'tbd1a2b3c4d5' && row.reqId === 'demo')
  check('走的是 /api/summary', asked.every((u) => u.startsWith('/api/summary')))
  check('不含事件流', row.recentEvents === undefined)
  check('不含阶段表', row.stages === undefined)
  check('不含进程配置（那是实例页的事）', row.config === undefined && row.resources === undefined)
  check('带告警计数', typeof body.alerts === 'number' && body.alerts === 0)
  // QQ 时代行里还有 groupName（群名），删通道后恒为 null，前端已经把这一列删了
  check('没有 QQ 时代的群名字段值', row.groupName === null || row.groupName === undefined)
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
  check('带会话数量用于汇总', Array.isArray(inst.groups) && inst.groups.length === 1)
}

console.log('\n== 详情 /api/board/detail ==')
{
  asked.length = 0
  const body = await (await fetch(`${base}/api/board/detail?pid=${process.pid}&groupId=tbd1a2b3c4d5`)).json()
  check('带进程的完整信息', body.instance?.pid === process.pid && body.config?.model === 'fake-model')
  check('带资源占用', body.resources?.rssMb === 10)
  check('走的是 /api/status', asked.some((u) => u.startsWith('/api/status')))
  check('只回这一行对应的会话', body.group?.groupId === 'tbd1a2b3c4d5')
  check('会话上带阶段表', Array.isArray(body.group?.stages) && body.group.stages.length === 1)
  check('会话上带阶段开始时间', typeof body.group?.stageStartedAt === 'number')
  check('不回事件流（弹窗走 /api/logs）', body.recentEvents === undefined)
}

console.log('\n== 边界 ==')
{
  const r = await fetch(`${base}/api/board/detail?pid=999999&groupId=tbd1a2b3c4d5`)
  check('不存在的 pid 返回 404', r.status === 404)

  const r2 = await fetch(`${base}/api/board/detail?groupId=tbd1a2b3c4d5`)
  check('缺 pid 返回 400', r2.status === 400)

  const r3 = await fetch(`${base}/api/instances/123`)
  check('旧的路径式详情已 404', r3.status === 404)

  const r4 = await fetch(`${base}/api/instances?pid=${process.pid}`)
  const body4 = await r4.json()
  check('/api/instances 不再兼任详情', Array.isArray(body4.instances) && body4.full === undefined)
}

console.log('\n== 配置读写 /api/settings ==')
{
  const read = await fetch(`${base}/api/settings`)
  const readBody = await read.json()
  check('读接口 GET /api/settings 返回 200', read.status === 200 && readBody.ok === true)

  const save = await fetch(`${base}/api/settings/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stageTimeouts: { default: 30, dev: 60, test: 30, acceptance: 15 } }),
  })
  const saved = await save.json()
  check('写接口是 POST /api/settings/save', save.status === 200 && saved.ok === true)
  check('写操作已落盘', readFileSync(join(repoRoot, 'bot.config.json'), 'utf8').includes('"acceptance": 15'))

  const oldPut = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  check('旧的 PUT /api/settings 已不可用', oldPut.status === 404)

  const barePost = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  check('POST /api/settings 不再兼任写入', barePost.status === 404)
}

console.log('\n== 操作转发 /api/threads ==')
{
  asked.length = 0
  lastPostBody = null
  const r = await fetch(`${base}/api/threads/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: 'tbd1a2b3c4d5' }),
  })
  check('stop 返回 200', r.status === 200)
  check('转发到 bridge 的 /api/threads/stop', asked.includes('/api/threads/stop'))
  check('threadId 从 body 传下去', lastPostBody?.threadId === 'tbd1a2b3c4d5')

  const missing = await fetch(`${base}/api/threads/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  check('缺 threadId 返回 400', missing.status === 400)

  const badJson = await fetch(`${base}/api/threads/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  check('非法 JSON 返回 400', badJson.status === 400)

  const oldPath = await fetch(`${base}/api/groups/100/stop`, { method: 'POST' })
  check('旧的路由已 404', oldPath.status === 404)

  // 老前端（或者别的脚本）还在传 groupId 时要继续认，不然升级后点终止就报 400
  lastPostBody = null
  const compat = await fetch(`${base}/api/threads/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupId: 'tbd1a2b3c4d5' }),
  })
  check('兼容旧字段 groupId', compat.status === 200 && lastPostBody?.threadId === 'tbd1a2b3c4d5')
}

await new Promise((r) => panel.close(r))
await new Promise((r) => fakeBridge.close(r))
rmSync(repoRoot, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
