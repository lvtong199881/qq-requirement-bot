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

const DEFAULT_PORT = 7880

/** 平台能力描述：调用方据此拼命令，不用自己判断平台差异 */
const CAPABILITIES = {
  harmony: {
    platform: 'harmony',
    label: '鸿蒙',
    // 构建与单测都走 hvigor；--no-daemon 是必须的，这台机器上 daemon 会卡死
    build: {
      tool: 'hvigor',
      args: ['--mode', 'module', '-p', 'module=entry@default', 'assembleHap', '--no-daemon'],
    },
    test: {
      tool: 'hvigor',
      args: ['--mode', 'module', '-p', 'module=entry@default', 'test', '--no-daemon'],
    },
    // 装包与驱动设备用的工具
    deploy: { install: 'hdc', installArgs: ['install'] },
    sdkEnv: 'DEVECO_SDK_HOME',
  },
  android: {
    platform: 'android',
    label: 'Android',
    build: { tool: 'gradle', args: ['assembleDebug'] },
    test: { tool: 'gradle', args: ['testDebugUnitTest'] },
    deploy: { install: 'adb', installArgs: ['install', '-r'] },
    sdkEnv: 'ANDROID_HOME',
  },
  ios: {
    platform: 'ios',
    label: 'iOS',
    build: { tool: 'xcodebuild', args: ['-scheme', 'App', 'build'] },
    test: { tool: 'xcodebuild', args: ['test'] },
    deploy: { install: 'xcrun', installArgs: ['simctl', 'install'] },
    sdkEnv: 'DEVELOPER_DIR',
  },
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
  const mgr = createEmulatorManager(cfg)

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
        const caps = CAPABILITIES[cfg.platform ?? 'harmony'] ?? CAPABILITIES.harmony
        return json(res, 200, { ok: true, ...caps })
      }

      // ── 列表 ──
      if (req.method === 'GET' && path === '/api/emulators') {
        const list = mgr.list()
        return json(res, 200, { ...list, items: leaseableView() })
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
        log(`[emulator] 租出 ${picked.name} → ${reqId}（${stage}）`)
        return json(res, 200, { ok: true, deviceId: picked.name, lease: info })
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
