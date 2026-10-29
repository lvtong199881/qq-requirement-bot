/**
 * 模拟器服务：独立进程，对外提供模拟器管理的 HTTP 接口。
 *
 * 为什么单独成一个服务而不是一个模块：
 *   - 模拟器是机器级资源，和「谁在跑需求」无关。多个 bridge 实例、面板、
 *     以后的别的工具都要用它，进程内 import 会把它们焊死在一起。
 *   - 设备租约必须集中管理。分散在各个进程里的锁无法正确判断「这台设备现在归谁」。
 *   - 配置（平台、工具路径、启动参数）只在这里读一次，调用方不需要知道
 *     DevEco 装在哪、hdc 叫什么。
 *
 * 接口：
 *   GET    /healthz               存活 + 平台信息
 *   GET    /api/emulators         列出全部模拟器（含运行状态、租约持有者）
 *   POST   /api/emulators/:action start | stop | wipe | delete
 *   POST   /api/lease             申请一台可用设备（{"reqId","stage"}）
 *   DELETE /api/lease/:deviceId   释放设备
 *   GET    /api/capabilities      当前平台能力（编译命令、测试命令等）
 *
 * 启动：node src/emulator-service.js [--port 7880]
 */
import { createServer } from 'node:http'
import { loadConfig } from './config.js'
import { createEmulatorManager } from './infra/emulator.js'
import { PLATFORMS } from './infra/platform.js'

const DEFAULT_PORT = 7880

/**
 * 平台能力：直接从 platform.js 派生，不再单独维护一份。
 * 以前这里有一套 build/test/deploy 定义，和 infra/platform.js 各写各的，
 * 加一个平台要改两处，迟早对不上。
 */
function capabilitiesOf(platformId) {
  const p = PLATFORMS[platformId] ?? PLATFORMS.harmony
  return {
    ok: true,
    platform: p.id,
    label: p.label,
    artifactExt: p.artifactExt,
    sdkEnv: p.sdkEnv,
    build: p.build,
    test: p.test,
    install: p.install,
    uninstall: p.uninstall,
    notes: p.notes ?? [],
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) {
        req.destroy()
        resolve(null)
      }
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * 启动模拟器服务。
 * @returns {Promise<import('node:http').Server>}
 */
export function startEmulatorService({ port = DEFAULT_PORT, config, log = console.log } = {}) {
  const cfg = config ?? loadConfig()
  // 默认看主仓库的平台；面板可以指定 ?repo=<id> 查另一个仓库的模拟器
  const managerFor = (repoId) => {
    const repo = repoId
      ? (cfg.repos ?? []).find((r) => r.id === repoId)
      : cfg.primaryRepo
    const plat = repo?.platform ?? cfg.platform
    // 工具是按平台配的：鸿蒙有 hdc，Android 有 adb/emulator/avdmanager
    return createEmulatorManager({ platform: plat, tools: cfg.tools?.[plat] ?? {}, bootWaitMs: cfg.bootWaitMs })
  }
  const mgr = managerFor()

  /**
   * 设备租约：deviceId → { reqId, stage, at }
   * 只在内存里——服务重启后租约全丢，但那时调用方的回合也已经断了，
   * 重新申请是正确行为，不应该把旧租约当成有效状态。
   */
  const leases = new Map()

  /** 有效设备 = 运行中 且 没被别人租走 */
  function leaseableView() {
    return mgr.list().items.map((e) => ({
      ...e,
      leased: leases.has(e.name),
      lease: leases.get(e.name) ?? null,
    }))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname

    try {
      // ── 存活与能力 ──
      if (req.method === 'GET' && path === '/healthz') {
        const list = mgr.list()
        return json(res, 200, {
          ok: true,
          platform: list.platform,
          label: list.label,
          total: list.items.length,
          running: list.items.filter((x) => x.running).length,
          leased: leases.size,
          uptimeSec: Math.round(process.uptime()),
        })
      }

      if (req.method === 'GET' && path === '/api/capabilities') {
        return json(res, 200, capabilitiesOf(cfg.platform ?? 'harmony'))
      }

      // ── 列表 ──
      if (req.method === 'GET' && path === '/api/emulators') {
        const repoId = url.searchParams.get('repo') ?? undefined
        const m = repoId ? managerFor(repoId) : mgr
        const list = m.list()
        return json(res, 200, { ...list, repo: repoId ?? cfg.primaryRepo?.id, items: leaseableView() })
      }

      // ── 启停与清理 ──
      const action = path.match(/^\/api\/emulators\/(start|stop|wipe|delete)$/)
      if (action && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        const name = String(body.name ?? '').trim()
        if (!name) return json(res, 400, { ok: false, error: '缺少 name' })

        // 删除/清数据前确认没被租走——别人正在用的时候抹掉数据是灾难
        if ((action[1] === 'delete' || action[1] === 'wipe') && leases.has(name)) {
          return json(res, 409, {
            ok: false,
            error: `设备被 ${leases.get(name).reqId} 占用，先释放再操作`,
            lease: leases.get(name),
          })
        }

        const result =
          action[1] === 'start'
            ? await mgr.start(name, { reset: body.reset === true })
            : action[1] === 'stop'
              ? await mgr.stop(name)
              : action[1] === 'wipe'
                ? await mgr.wipe(name)
                : await mgr.remove(name)

        log(`[emulator] ${action[1]} ${name}${result.ok ? '' : ' 失败：' + result.error}`)
        return json(res, result.ok ? 200 : 400, result)
      }

      // ── 租约 ──
      if (req.method === 'POST' && path === '/api/lease') {
        const body = await readJsonBody(req)
        if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })

        const reqId = String(body.reqId ?? '')
        const stage = String(body.stage ?? '')
        if (!reqId) return json(res, 400, { ok: false, error: '缺少 reqId' })

        // 同一个需求重复申请：还回原来那台，不要多占
        for (const [deviceId, info] of leases) {
          if (info.reqId === reqId) {
            return json(res, 200, { ok: true, deviceId, reused: true, lease: info })
          }
        }

        const candidates = mgr.list().items.filter((e) => e.running && !leases.has(e.name))
        if (!candidates.length) {
          const running = mgr.list().items.filter((e) => e.running).length
          return json(res, 409, {
            ok: false,
            error: running ? `${running} 台设备都在忙` : '没有运行中的设备',
            leases: [...leases.entries()].map(([id, v]) => ({ deviceId: id, ...v })),
          })
        }

        const picked = candidates[0]
        const info = { reqId, stage, at: Date.now() }
        leases.set(picked.name, info)
        // deviceId 是「装包时该用的那个标识」：鸿蒙就是设备名，
        // Android 是 emulator-5554（AVD 名没法直接 adb -s）
        const target = picked.deviceId ?? picked.name
        log(`[emulator] 租出 ${picked.name} → ${reqId}（${stage}）${target !== picked.name ? `，adb 设备 ${target}` : ''}`)
        return json(res, 200, {
          ok: true,
          deviceId: target,
          avdName: picked.name !== target ? picked.name : undefined,
          lease: info,
        })
      }

      const release = path.match(/^\/api\/lease\/(.+)$/)
      if (release && req.method === 'DELETE') {
        const deviceId = decodeURIComponent(release[1])
        const had = leases.get(deviceId)
        leases.delete(deviceId)
        if (had) log(`[emulator] 释放 ${deviceId}（${had.reqId}）`)
        return json(res, 200, { ok: true, deviceId, released: !!had })
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const list = mgr.list()
      log(`模拟器服务已启动：http://127.0.0.1:${port}`)
      log(`  ${list.label}：${list.items.length} 台，运行中 ${list.items.filter((x) => x.running).length} 台`)
      resolve(server)
    })
  })
}

// 直接运行：node src/emulator-service.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.find((a) => a.startsWith('--port='))
  const port = Number(portArg?.split('=')[1] ?? process.env.EMULATOR_PORT ?? DEFAULT_PORT)
  await startEmulatorService({ port })
}
