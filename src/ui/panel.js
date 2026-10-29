/**
 * 管理面板：常驻进程，聚合所有 bridge 实例，提供 /console 页面。
 *
 * 架构：
 *   bridge  ← 暴露 /api/status、/api/logs、/api/groups/{stop,restart}
 *   panel   ← 扫描 .instances/*.json 发现实例，逐个拉状态，转发操作
 *
 * 面板与 bridge 分离的好处：bridge 崩了面板还活着，能告诉你它崩了。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InstanceRegistry } from '../instances.js'
import { createEmulatorClient } from '../infra/emulator-client.js'
import { reloadConfigInto } from '../config.js'
import { MESSAGE_TEMPLATES, MESSAGE_VARS, validateAllMessages } from './messages.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC = join(HERE, '..', '..', 'static')

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

/** 读 JSON 请求体：空体返回 {}，非法 JSON 返回 null（调用方据此回 400） */
async function readJsonBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return null
  }
}

/** 拉一个实例的状态；失败返回带 error 的占位对象 */
async function fetchStatus(inst, path = '/api/status', timeoutMs = 2500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${inst.port}${path}`, { signal: ac.signal })
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
    const status = await fetchStatus(inst, '/api/summary')
    if (status.unreachable) continue
    const owns = (status.groups ?? []).some((g) => String(g.groupId) === String(groupId))
    if (!owns) continue

    const url = `http://127.0.0.1:${inst.port}/api/groups/${action}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-panel-token': token } : {}) },
      body: JSON.stringify({ groupId: String(groupId) }),
    })
    return await r.json()
  }
  return { ok: false, error: `没有实例在服务群 ${groupId}` }
}

/**
 * 解析用户输入的 QQ 白名单。
 * 允许中英文逗号、空格、换行分隔；容忍空值（= 清空白名单）。
 * 返回 { ok, list } 或 { ok:false, error }。
 */
export function parseAdminUsers(raw) {
  if (raw == null) return { ok: true, list: [] }
  const text = String(raw).trim()
  if (!text) return { ok: true, list: [] }

  const parts = text
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

  const bad = parts.filter((x) => !/^\d{4,12}$/.test(x))
  if (bad.length) {
    return {
      ok: false,
      error: `这些不是合法的 QQ 号（只能是 4~12 位数字）：${bad.join('、')}`,
    }
  }

  // 去重但保留顺序
  const list = [...new Set(parts)]
  if (list.length > 50) return { ok: false, error: `最多 50 个，当前 ${list.length} 个` }
  return { ok: true, list }
}

/** 读 bot.config.json 里的可编辑项 */
/** 面板只提供这几档；传入别的值一律拒绝，避免手改成 3 分钟把回合切成碎片 */
const TIMEOUT_OPTIONS = [10, 15, 30, 60]

/** 校验四个阶段的超时：只接受白名单档位 */
function parseStageTimeouts(input) {
  const keys = ['default', 'dev', 'test', 'acceptance']
  const out = {}
  for (const k of keys) {
    const n = Number(input?.[k])
    if (!TIMEOUT_OPTIONS.includes(n)) {
      return { ok: false, error: `${k} 必须是 ${TIMEOUT_OPTIONS.join(' / ')} 之一（当前 ${input?.[k]}）` }
    }
    out[k] = n
  }
  return { ok: true, value: out }
}

function readSettings(repoRoot) {
  const file = join(repoRoot, 'bot.config.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return {
      ok: true,
      adminUsers: raw.adminUsers ?? [],
      // 超级管理员只读展示，面板不提供编辑（避免把自己锁出去）
      superAdmin: raw.superAdmin ?? [],
      // 群消息文案：每条带默认值、当前值、是否自定义
      messages: Object.entries(MESSAGE_TEMPLATES).map(([key, def]) => ({
        key,
        group: def.group,
        label: def.label,
        desc: def.desc ?? '',
        vars: def.vars,
        defaultTemplate: def.template,
        template: raw.messageTemplates?.[key]?.trim() ? raw.messageTemplates[key] : def.template,
        custom: !!(raw.messageTemplates?.[key] && raw.messageTemplates[key].trim()),
      })),
      messageVars: MESSAGE_VARS,
      stageTimeouts: {
        default: raw.stageTimeouts?.default ?? 30,
        dev: raw.stageTimeouts?.dev ?? 60,
        test: raw.stageTimeouts?.test ?? 60,
        acceptance: raw.stageTimeouts?.acceptance ?? 60,
      },
      timeoutOptions: TIMEOUT_OPTIONS,
    }
  } catch (err) {
    return { ok: false, error: `读配置失败：${err.message}`, adminUsers: [], superAdmin: [] }
  }
}

/** 写回 bot.config.json，只改传进来的字段，其余原样保留 */
function writeSettings(repoRoot, patch) {
  const file = join(repoRoot, 'bot.config.json')
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { ok: false, error: `读配置失败：${err.message}` }
  }
  if (patch.superAdmin !== undefined) {
    return { ok: false, error: 'superAdmin 只能在 bot.config.json 里手动修改' }
  }
  if (patch.adminUsers !== undefined) raw.adminUsers = patch.adminUsers
  if (patch.stageTimeouts !== undefined) {
    raw.stageTimeouts = {
      default: patch.stageTimeouts.default,
      dev: patch.stageTimeouts.dev,
      test: patch.stageTimeouts.test,
      acceptance: patch.stageTimeouts.acceptance,
    }
  }
  if (patch.messageTemplates !== undefined) {
    // 空 = 全部回默认；某条等于默认值也不写入，保持配置干净
    const clean = {}
    for (const [k, v] of Object.entries(patch.messageTemplates || {})) {
      if (typeof v === 'string' && v.trim() && v !== MESSAGE_TEMPLATES[k]?.template) clean[k] = v
    }
    if (Object.keys(clean).length) raw.messageTemplates = clean
    else delete raw.messageTemplates
  }
  try {
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `写配置失败：${err.message}` }
  }
}

/** 通知所有活着的实例热更新设置 */
async function pushSettings(instances, patch, token) {
  const results = []
  for (const inst of instances) {
    try {
      const r = await fetch(`http://127.0.0.1:${inst.port}/api/settings/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-panel-token': token } : {}) },
        body: JSON.stringify(patch),
      })
      results.push({ pid: inst.pid, ok: r.ok })
    } catch (err) {
      results.push({ pid: inst.pid, ok: false, error: err.message })
    }
  }
  return results
}

export function startPanel({ repoRoot, port = 7879, token, config = {} }) {
  const registry = new InstanceRegistry(repoRoot)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname

    try {
      // 页面
      // 前端用真实路径做路由（/console/emulators 这种），刷新要能直接命中，
      // 所以 /console 下所有子路径都回同一份 HTML，视图切换由前端按 pathname 决定。
      if (path === '/' || path === '/console' || path.startsWith('/console/')) {
        return serveStatic(res, 'console.html')
      }
      if (path === '/vue.js') return serveStatic(res, 'vue.global.prod.js')

      // 需求大盘：按「群」维度摊平，前端拿到就能直接画表格
      if (path === '/api/board') {
        const list = registry.list({ cleanup: true })
        const statuses = await Promise.all(list.map((i) => fetchStatus(i, '/api/summary')))
        const rows = []
        let alerts = 0
        // 并发资源是「实例级」的，但大盘按群展示，所以每个实例的池状态
        // 单独收一份给前端画总览，行里只带这个群自己的排队信息。
        const pools = []
        for (const s of statuses) {
          if (s.unreachable || (s.onebot && s.onebot.connected === false)) alerts += 1
          if (s.pools && !s.unreachable) {
            pools.push({ pid: s.instance?.pid ?? null, ...s.pools })
          }
          for (const g of s.groups ?? []) {
            rows.push({
              pid: s.instance?.pid ?? null,
              unreachable: s.unreachable === true,
              error: s.error ?? null,
              ...g,
            })
          }
        }
        return json(res, 200, { rows, alerts, pools, at: Date.now() })
      }

      // 实例页：按「进程」维度，只在切过去时拉一次
      if (path === '/api/instances') {
        const list = registry.list({ cleanup: true })
        const statuses = await Promise.all(list.map((i) => fetchStatus(i, '/api/summary')))
        return json(res, 200, { instances: statuses, at: Date.now() })
      }

      // 大盘某一行展开：一个群 + 它所在进程的完整状态
      if (path === '/api/board/detail') {
        const pid = url.searchParams.get('pid')
        const groupId = url.searchParams.get('groupId')
        if (!pid) return json(res, 400, { ok: false, error: '缺少 pid' })
        const inst = registry.list().find((x) => String(x.pid) === String(pid))
        if (!inst) return json(res, 404, { ok: false, error: '这个实例已经不在运行了' })

        const full = await fetchStatus(inst, '/api/status')
        if (full.unreachable) {
          return json(res, 200, { instance: full.instance, unreachable: true, error: full.error })
        }
        return json(res, 200, {
          instance: full.instance,
          config: full.config,
          onebot: full.onebot,
          resources: full.resources,
          // 只回这一行对应的群，前端不用再从 groups 里翻
          group: (full.groups ?? []).find((g) => String(g.groupId) === String(groupId)) ?? null,
        })
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

      // 设置：读
      if (path === '/api/settings' && req.method === 'GET') {
        return json(res, 200, readSettings(repoRoot))
      }

      // 设置：写（校验 → 落盘 → 通知各实例热更新）
      if (path === '/api/settings/save' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })

        // superAdmin 只能在配置文件里改，面板拒绝
        if (body.superAdmin !== undefined) {
          return json(res, 400, { ok: false, error: 'superAdmin 只能在 bot.config.json 里手动修改' })
        }
        if (
          body.adminUsers === undefined &&
          body.messageTemplates === undefined &&
          body.stageTimeouts === undefined
        ) {
          return json(res, 400, {
            ok: false,
            error: '没有要保存的字段（adminUsers / messageTemplates / stageTimeouts）',
          })
        }

        const patch = {}

        if (body.stageTimeouts !== undefined) {
          const v = parseStageTimeouts(body.stageTimeouts)
          if (!v.ok) return json(res, 400, { ok: false, error: v.error })
          patch.stageTimeouts = v.value
        }

        if (body.adminUsers !== undefined) {
          const parsed = parseAdminUsers(body.adminUsers)
          if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error })
          patch.adminUsers = parsed.list
        }

        if (body.messageTemplates !== undefined) {
          const v = validateAllMessages(body.messageTemplates)
          if (!v.ok) return json(res, 400, { ok: false, error: v.error })
          patch.messageTemplates = body.messageTemplates
        }

        const written = writeSettings(repoRoot, patch)
        if (!written.ok) return json(res, 500, written)

        const pushed = await pushSettings(registry.list(), patch, token)
        const fresh = readSettings(repoRoot)
        return json(res, 200, { ok: true, ...fresh, hotReloaded: pushed })
      }

      // 项目（仓库）配置：面板直接读写 bot.config.json，不经过 bridge
      if (path === '/api/projects' && req.method === 'GET') {
        return json(res, 200, { ok: true, repos: config.repos ?? [], platform: config.platform })
      }

      if (path === '/api/projects/save' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })

        const repos = Array.isArray(body.repos) ? body.repos : null
        if (!repos) return json(res, 400, { ok: false, error: '缺少 repos' })

        // 校验：id 唯一、path 存在、平台合法、primary 唯一
        const ids = new Set()
        for (const r of repos) {
          // id 可以空（新增的项目），name 和 url 必须有
          const id = String(r.id ?? '').trim()
          if (id) {
            if (ids.has(id)) return json(res, 400, { ok: false, error: `id 重复：${id}` })
            ids.add(id)
          }
          const label = String(r.name ?? id ?? '新项目')

          // 只认 git 链接：本地目录由 bot 克隆，不要求用户先在每台机器上 clone
          const url = String(r.url ?? r.path ?? '').trim()
          if (!url) return json(res, 400, { ok: false, error: `${label} 缺少 git 链接` })
          if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
            return json(res, 400, { ok: false, error: `${label} 的链接不像 git 地址：${url}` })
          }

          const plat = String(r.platform ?? 'harmony')
          if (!['harmony', 'android', 'ios'].includes(plat)) {
            return json(res, 400, { ok: false, error: `${label} 的平台不认识：${plat}` })
          }
        }
        if (repos.length === 0) return json(res, 400, { ok: false, error: '至少保留一个项目' })

        try {
          const cfgPath = config.configPath
          const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'))
          onDisk.repos = repos.map((r, i) => {
            // id 建出来就不改；新增的（没带 id）在这里生成一个随机的
            const id = String(r.id ?? '').trim() || `r${Math.random().toString(36).slice(2, 10)}`
            const name = String(r.name ?? '').trim() || id
            return {
              id,
              name,
              url: String(r.url ?? r.path ?? '').trim(),
              platform: String(r.platform ?? 'harmony'),
            }
          })
          writeFileSync(cfgPath, JSON.stringify(onDisk, null, 2) + '\n')

          // 就地刷新内存，下一次请求就是新配置
          reloadConfigInto(config, cfgPath)
          console.log(`[项目] 已更新：${config.repos.map((r) => `${r.id}(${r.platform})`).join('、')}`)

          // 让 bridge 也跟着刷新（它们各自有一份 config 引用）
          await pushSettings(registry.list(), { repos: onDisk.repos }, token)
          return json(res, 200, { ok: true, repos: config.repos })
        } catch (err) {
          return json(res, 500, { ok: false, error: `保存失败：${err.message}` })
        }
      }

      // 模拟器：列出来（含未启动的）和各类操作。
      // 这是机器级资源，不分实例，所以放在面板这一层统一管理。
      // 模拟器是独立服务，面板只做转发——不重复实现一遍设备管理
      if (path === '/api/emulators' && req.method === 'GET') {
        const platform = url.searchParams.get('platform') ?? undefined
        const repoId = url.searchParams.get('repo') ?? undefined
        const r = await createEmulatorClient(config).list({ platform, repoId })
        return json(res, 200, r)
      }

      const emuAction = path.match(/^\/api\/emulators\/(start|stop|wipe|delete)$/)
      if (emuAction && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        const name = String(body.name ?? '').trim()
        if (!name) return json(res, 400, { ok: false, error: '缺少 name' })

        const client = createEmulatorClient(config)
        const action = emuAction[1]
        const platform = body.platform ?? undefined
        const result =
          action === 'start'
            ? await client.start(name, { reset: body.reset === true, platform })
            : action === 'stop'
              ? await client.stop(name, { platform })
              : action === 'wipe'
                ? await client.wipe(name, { platform })
                : await client.remove(name, { platform })

        console.log(`[模拟器] ${action} ${name}${result.ok ? '' : ' 失败：' + result.error}`)
        return json(res, result.ok ? 200 : 400, result)
      }

      // 操作：终止 / 重启 —— groupId 走 body，不塞进路径
      const m = path.match(/^\/api\/groups\/(stop|restart)$/)
      if (m && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        const groupId = String(body.groupId ?? '')
        if (!groupId) return json(res, 400, { ok: false, error: '缺少 groupId' })
        const result = await dispatch(registry.list(), groupId, m[1], token)
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
  const { loadConfig } = await import('../config.js')
  let config
  try {
    config = loadConfig()
  } catch {
    config = { repoRoot: process.cwd() }
  }
  // 面板用独立的对外端口（bridge 自己占 panel.port，避免撞车）
  const port = Number(process.env.PANEL_PORT ?? config.panel?.publicPort ?? 7879)
  const token = process.env.PANEL_TOKEN ?? config.panel?.token ?? ''
  await startPanel({ repoRoot: config.repoRoot ?? process.cwd(), port, token, config })
  console.log(`\n  管理面板已启动：http://127.0.0.1:${port}/console\n`)
}
