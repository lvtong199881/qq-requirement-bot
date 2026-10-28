/**
 * 模拟器管理：发现、启动、停止、清除数据、删除。
 *
 * 这是基础能力，和需求流程无关——它只管「这台机器上有哪些模拟器、各自什么状态、
 * 怎么把它们开起来」。编排层通过 HTTP 接口调用它（面板的 /api/emulators），
 * 决策「什么时候需要模拟器」是编排层的事，这里不掺业务判断。
 *
 * 平台差异封装在适配器里。鸿蒙走 DevEco 的 Emulator CLI，Android 走 emulator/adb，
 * iOS 走 xcrun simctl。上层只认 { name, type, running, platform } 这套统一结构。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_BIN = {
  harmony: '/Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator',
  android: 'emulator',
  ios: 'xcrun',
}

function run(bin, args, { timeout = 60_000, input } = {}) {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      timeout,
      input,
    })
    return { ok: true, out: String(out ?? '') }
  } catch (err) {
    const stderr = String(err?.stderr ?? '').trim()
    const stdout = String(err?.stdout ?? '').trim()
    return { ok: false, error: stderr || stdout || err.message, code: err.status }
  }
}

/** 鸿蒙：DevEco 的 Emulator CLI */
const harmonyAdapter = {
  label: '鸿蒙',

  list(cfg) {
    const bin = cfg.bin ?? DEFAULT_BIN.harmony
    if (!existsSync(bin)) return { ok: false, error: `找不到模拟器 CLI：${bin}`, items: [] }
    const r = run(bin, ['-list', '-details'])
    if (!r.ok) return { ok: false, error: r.error, items: [] }

    let arr
    try {
      arr = JSON.parse(r.out)
    } catch {
      return { ok: false, error: '模拟器列表返回的不是合法 JSON', items: [] }
    }
    return {
      ok: true,
      items: arr.map((x) => ({
        name: x.name,
        type: x.deviceType ?? 'unknown',
        model: x.productModel ?? null,
        os: x['os.osVersion'] ?? null,
        running: String(x.isRunning) === 'true',
        path: x.instancePath ?? null,
        platform: 'harmony',
        raw: x,
      })),
    }
  },

  /**
   * 启动。bootMode：
   *   coldboot（默认，带已有数据启动）
   *   reset    （带数据重置启动 = 清除数据）
   */
  start(cfg, name, { reset = false, noWindow = true } = {}) {
    const bin = cfg.bin ?? DEFAULT_BIN.harmony
    const args = ['-start', name]
    if (noWindow) args.push('-noWindow')
    if (reset) args.push('-bootMode', 'reset')

    // 这个 CLI 启动后自己就是长驻进程（模拟器本体），不能等它退出——
    // execFileSync 会一直阻塞到超时被杀，进程反而没起来。必须 detached 甩到后台。
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, pid: child.pid }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  },

  stop(cfg, name) {
    const bin = cfg.bin ?? DEFAULT_BIN.harmony
    const r = run(bin, ['-stop', name], { timeout: 30_000 })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },

  remove(cfg, name) {
    const bin = cfg.bin ?? DEFAULT_BIN.harmony
    const r = run(bin, ['-delete', name, '-force'], { timeout: 60_000 })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },
}

/** Android：emulator -list-avds + adb 判在线 */
const androidAdapter = {
  label: 'Android',

  /**
   * 列出 AVD 并标出哪些在跑。
   *
   * 难点是「AVD 名」和「adb 设备名」对不上：AVD 叫 Pixel_7_API_34，
   * adb 那边是 emulator-5554。之前只判断「有设备在线就算在跑」，
   * 多台模拟器时全都会被标成运行中。
   * 现在反过来问：adb 设备自己知道它跑的是哪个 AVD（`adb -s <id> emu avd name`）。
   */
  list(cfg) {
    const bin = cfg.bin ?? DEFAULT_BIN.android
    const avds = run(bin, ['-list-avds'])
    if (!avds.ok) return { ok: false, error: avds.error, items: [] }
    const names = avds.out.split('\n').map((l) => l.trim()).filter(Boolean)

    // 在线设备 → 它跑的 AVD 名
    const runningByAvd = new Map()
    const adb = run(cfg.adb ?? 'adb', ['devices'])
    if (adb.ok) {
      for (const line of adb.out.split('\n').slice(1)) {
        const [id, state] = line.trim().split(/\s+/)
        if (!id || state !== 'device') continue
        // 只有模拟器能反查 AVD 名，真机查不到（也不该算进 AVD 列表）
        if (!/^emulator-\d+$/.test(id)) continue
        const name = run(cfg.adb ?? 'adb', ['-s', id, 'emu', 'avd', 'name'])
        if (name.ok) {
          const avd = name.out.split('\n')[0].trim().replace(/^OK\s*/, '')
          if (avd) runningByAvd.set(avd, id)
        }
      }
    }

    return {
      ok: true,
      items: names.map((name) => ({
        name,
        type: 'phone',
        model: null,
        os: null,
        running: runningByAvd.has(name),
        // 记录 adb 设备名，装包时必须用它（-s emulator-5554）
        deviceId: runningByAvd.get(name) ?? null,
        path: null,
        platform: 'android',
      })),
    }
  },

  start(cfg, name, { reset = false, noWindow = true } = {}) {
    const bin = cfg.bin ?? DEFAULT_BIN.android
    const args = ['-avd', name]
    if (noWindow) args.push('-no-window')
    // 清除数据用 -wipe-data，从干净状态起
    if (reset) args.push('-wipe-data')
    // 和鸿蒙一样：emulator 启动后也是长驻进程
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, pid: child.pid }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  },

  stop(cfg, name) {
    // 停止要指定设备：先找出它对应的 adb 设备名，再用 emu kill
    const adbBin = cfg.adb ?? 'adb'
    const list = androidAdapter.list(cfg)
    const target = list.items?.find((x) => x.name === name)
    if (!target?.deviceId) {
      return { ok: false, error: `${name} 没有在运行（找不到对应的 adb 设备）` }
    }
    const r = run(adbBin, ['-s', target.deviceId, 'emu', 'kill'], { timeout: 30_000 })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },

  remove(cfg, name) {
    // 删 AVD 用 avdmanager，不是 emulator 自己的参数
    const mgr = cfg.avdmanager ?? 'avdmanager'
    const r = run(mgr, ['delete', 'avd', '-n', name], { timeout: 60_000 })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },
}

/** iOS：xcrun simctl */
const iosAdapter = {
  label: 'iOS',

  list(cfg) {
    const r = run(cfg.bin ?? DEFAULT_BIN.ios, ['simctl', 'list', 'devices', '--json'])
    if (!r.ok) return { ok: false, error: r.error, items: [] }
    let data
    try {
      data = JSON.parse(r.out)
    } catch {
      return { ok: false, error: 'simctl 返回的不是合法 JSON', items: [] }
    }
    const items = []
    for (const [runtime, list] of Object.entries(data.devices ?? {})) {
      for (const d of list) {
        items.push({
          name: d.name,
          type: 'phone',
          model: d.deviceTypeIdentifier ?? null,
          os: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, ''),
          running: d.state === 'Booted',
          path: d.udid,
          platform: 'ios',
        })
      }
    }
    return { ok: true, items }
  },

  start(cfg, name) {
    const r = run(cfg.bin ?? DEFAULT_BIN.ios, ['simctl', 'boot', name], { timeout: 120_000 })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },

  stop(cfg, name) {
    const r = run(cfg.bin ?? DEFAULT_BIN.ios, ['simctl', 'shutdown', name], { timeout: 60_000 })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },

  remove(cfg, name) {
    const r = run(cfg.bin ?? DEFAULT_BIN.ios, ['simctl', 'delete', name], { timeout: 60_000 })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },
}

const ADAPTERS = {
  harmony: harmonyAdapter,
  android: androidAdapter,
  ios: iosAdapter,
}

/** 平台适配器表（测试和文档用） */
export const PLATFORMS = ADAPTERS

/**
 * 模拟器管理器。只做设备本身的操作，不判断「现在该不该启动」——那是编排层的决定。
 */
export class EmulatorManager {
  /**
   * @param {object} o
   * @param {string} [o.platform] 当前平台（harmony/android/ios）
   * @param {object} [o.tools]    各平台工具路径 { bin, adb }
   * @param {number} [o.bootWaitMs] 启动后等设备上线的上限
   */
  constructor({ platform = 'harmony', tools = {}, bootWaitMs = 120_000 } = {}) {
    this.platform = platform
    this.tools = tools
    this.bootWaitMs = bootWaitMs
    this.adapter = ADAPTERS[platform] ?? harmonyAdapter
  }

  get label() {
    return this.adapter.label
  }

  /** 列出当前平台的全部模拟器（含未启动的） */
  list() {
    const r = this.adapter.list(this.tools)
    return {
      platform: this.platform,
      label: this.adapter.label,
      ok: r.ok !== false,
      error: r.error ?? null,
      items: r.items ?? [],
    }
  }

  /** 兼容旧接口：交给 device.js 判断在线用 */
  listOnline() {
    const r = this.list()
    return r.items.filter((x) => x.running)
  }

  async start(name, { reset = false, noWindow = true } = {}) {
    const before = this.list().items.find((x) => x.name === name)
    if (!before) return { ok: false, error: `没有这个模拟器：${name}` }
    if (before.running && !reset) return { ok: true, already: true, name }

    const r = this.adapter.start(this.tools, name, { reset, noWindow })
    if (!r.ok) return { ok: false, error: r.error }

    // 等它真的可连接，而不是「命令返回了」就算好
    const ok = await this.#waitRunning(name, reset)
    return ok ? { ok: true, name, waitedMs: ok } : { ok: false, error: '启动超时，模拟器没有上线' }
  }

  async stop(name) {
    const r = this.adapter.stop(this.tools, name)
    return r.ok ? { ok: true, name } : { ok: false, error: r.error }
  }

  /** 清除数据：重置启动一次再关掉，保留模拟器本身 */
  async wipe(name) {
    const item = this.list().items.find((x) => x.name === name)
    if (!item) return { ok: false, error: `没有这个模拟器：${name}` }

    // 先停，避免带着旧数据启动
    await this.stop(name)
    await new Promise((res) => setTimeout(res, 2000))

    const r = this.adapter.start(this.tools, name, { reset: true, noWindow: true })
    if (!r.ok) return { ok: false, error: r.error }

    const up = await this.#waitRunning(name, true)
    if (!up) return { ok: false, error: '清除数据后模拟器没有启动起来' }
    // 数据已重置，关掉交还给调用方
    await this.stop(name)
    return { ok: true, name }
  }

  /** 完全删除 */
  async remove(name) {
    const item = this.list().items.find((x) => x.name === name)
    if (!item) return { ok: false, error: `没有这个模拟器：${name}` }
    if (item.running) {
      const stopped = await this.stop(name)
      if (!stopped.ok) return { ok: false, error: `先关闭失败：${stopped.error}` }
      await new Promise((res) => setTimeout(res, 2000))
    }
    const r = this.adapter.remove(this.tools, name)
    return r.ok ? { ok: true, name } : { ok: false, error: r.error }
  }

  /** 轮询直到该模拟器 isRunning 或超时，返回耗时毫秒 */
  async #waitRunning(name, required) {
    const started = Date.now()
    while (Date.now() - started < this.bootWaitMs) {
      const item = this.list().items.find((x) => x.name === name)
      if (item?.running) return Date.now() - started
      await new Promise((res) => setTimeout(res, 3000))
    }
    return 0
  }
}

/** 从配置构造管理器（面板和编排层共用一份配置） */
export function createEmulatorManager(config) {
  return new EmulatorManager({
    platform: config.platform ?? 'harmony',
    tools: config.tools ?? {},
  })
}
