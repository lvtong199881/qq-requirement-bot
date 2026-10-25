/**
 * 管理面板：常驻进程，聚合所有 bridge 实例，提供 /console 页面。
 *
 * 架构：
 *   bridge  ← 暴露 /api/status、/api/logs、/api/groups/:id/{stop,restart}
 *   panel   ← 扫描 .instances/*.json 发现实例，逐个拉状态，转发操作
 *
 * 面板与 bridge 分离的好处：bridge 崩了面板还活着，能告诉你它崩了。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InstanceRegistry } from './instances.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC = join(HERE, '..', 'static')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function serveStatic(res, name) {
  const file = join(STATIC, name)
  if (!existsSync(file)) {
    res.writeHead(404).end('not found')
    return
  }
  const ext = name.slice(name.lastIndexOf('.'))
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  res.end(readFileSync(file))
}

/** 拉一个实例的状态；失败返回带 error 的占位对象 */
async function fetchStatus(inst, timeoutMs = 2500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${inst.port}/api/status`, { signal: ac.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } catch (err) {
    return {
      instance: { pid: inst.pid, port: inst.port, startedAt: inst.startedAt },
      unreachable: true,
      error: err.name === 'AbortError' ? '请求超时' : err.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 把操作转发给「持有某个群」的那个实例 */
async function dispatch(instances, groupId, action, token) {
  for (const inst of instances) {
    const status = await fetchStatus(inst)
    if (status.unreachable) continue
    const owns = (status.groups ?? []).some((g) => String(g.groupId) === String(groupId))
    if (!owns) continue

    const url = `http://127.0.0.1:${inst.port}/api/groups/${groupId}/${action}`
    const r = await fetch(url, {
      method: 'POST',
      headers: token ? { 'x-panel-token': token } : {},
    })
    return await r.json()
  }
  return { ok: false, error: `没有实例在服务群 ${groupId}` }
}

export function startPanel({ repoRoot, port = 7879, token }) {
  const registry = new InstanceRegistry(repoRoot)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname

    try {
      // 页面
      if (path === '/' || path === '/console') return serveStatic(res, 'console.html')
      if (path === '/vue.js') return serveStatic(res, 'vue.global.prod.js')

      // 聚合所有实例
      if (path === '/api/instances') {
        const list = registry.list({ cleanup: true })
        const statuses = await Promise.all(list.map((i) => fetchStatus(i)))
        return json(res, 200, { instances: statuses, at: Date.now() })
      }

      // 某实例的日志
      if (path === '/api/logs') {
        const pid = url.searchParams.get('pid')
        const list = registry.list()
        const inst = list.find((x) => String(x.pid) === String(pid)) ?? list[0]
        if (!inst) return json(res, 200, { logs: [] })
        const n = Math.min(1000, Number(url.searchParams.get('n') ?? 200) || 200)
        const r = await fetch(`http://127.0.0.1:${inst.port}/api/logs?n=${n}`)
        return json(res, 200, await r.json())
      }

      // 操作：终止 / 重启
      const m = path.match(/^\/api\/groups\/([^/]+)\/(stop|restart)$/)
      if (m && req.method === 'POST') {
        const list = registry.list()
        const result = await dispatch(list, m[1], m[2], token)
        return json(res, result.ok ? 200 : 400, result)
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

// 直接运行：node src/panel.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('./config.js')
  let config
  try {
    config = loadConfig()
  } catch {
    config = { repoRoot: process.cwd() }
  }
  // 面板用独立的对外端口（bridge 自己占 panel.port，避免撞车）
  const port = Number(process.env.PANEL_PORT ?? config.panel?.publicPort ?? 7879)
  const token = process.env.PANEL_TOKEN ?? config.panel?.token ?? ''
  await startPanel({ repoRoot: config.repoRoot ?? process.cwd(), port, token })
  console.log(`\n  管理面板已启动：http://127.0.0.1:${port}/console\n`)
}
