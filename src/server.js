/**
 * bridge 的本地 HTTP API —— 给管理面板看状态、下指令。
 *
 * 只监听 127.0.0.1：面板和管理员在同一台机器上，没有暴露到局域网的理由。
 * 零依赖，用 node:http。
 */
import { createServer } from 'node:http'

/** 简单 JSON 响应 */
function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * @param {object} o
 * @param {import('./runtime.js').Runtime} o.runtime
 * @param {object} o.config
 * @param {() => object} o.snapshot  组装本实例完整状态的函数（由 index.js 提供）
 * @param {() => object=} o.summary  精简版快照，只含面板列表要画的字段
 * @param {(groupId: string) => Promise<object>} o.stopGroup
 * @param {(groupId: string) => Promise<object>} o.restartGroup
 * @param {string=} o.token  写操作需要的令牌；不给则只允许本机无 token
 */
export function createBridgeServer({
  runtime,
  config,
  snapshot,
  summary,
  stopGroup,
  restartGroup,
  applySettings,
  token,
}) {
  const needToken = (req) => {
    if (!token) return true
    const got = req.headers['x-panel-token'] ?? new URL(req.url, 'http://x').searchParams.get('token')
    return got === token
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'

    try {
      // ── 只读 ──
      if (method === 'GET' && path === '/api/status') {
        return json(res, 200, snapshot())
      }

      // 精简版：面板大盘每 3 秒轮询的就是这个
      if (method === 'GET' && path === '/api/summary') {
        return json(res, 200, summary ? summary() : snapshot())
      }

      if (method === 'GET' && path === '/api/logs') {
        const n = Math.min(1000, Number(url.searchParams.get('n') ?? 100) || 100)
        const level = url.searchParams.get('level') ?? undefined
        return json(res, 200, { logs: runtime.recentLogs(n, level) })
      }

      if (method === 'GET' && path === '/api/ping') {
        return json(res, 200, { ok: true, pid: process.pid })
      }

      // ── 写操作 ──
      if (method === 'POST') {
        if (!needToken(req)) return json(res, 403, { ok: false, error: 'token 无效' })

        // 面板改了配置后通知本实例热更新（避免让用户重启 bridge）
        if (path === '/api/settings') {
          const body = await readBody(req)
          const result = applySettings?.(body) ?? { ok: false, error: '本实例不支持热更新' }
          return json(res, result.ok ? 200 : 400, result)
        }

        const m = path.match(/^\/api\/groups\/([^/]+)\/(stop|restart)$/)
        if (m) {
          const [, groupId, action] = m
          await readBody(req)
          const result = action === 'stop' ? await stopGroup(groupId) : await restartGroup(groupId)
          runtime.info(`[面板] ${action} ${groupId} → ${result.ok ? '成功' : '失败'}：${result.message ?? ''}`)
          return json(res, result.ok ? 200 : 400, result)
        }

        return json(res, 404, { ok: false, error: '未知接口' })
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      runtime.error(`HTTP ${method} ${path} 失败：${err.message}`)
      return json(res, 500, { ok: false, error: err.message })
    }
  })
}
