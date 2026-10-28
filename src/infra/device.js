/**
 * 设备资源：模拟器/真机的发现与独占分配。
 *
 * 为什么需要它：开发、测试、验收三个阶段都要往设备上装包跑，
 * 而设备是独占资源——两个回合同时往同一台设备装包，会出现
 * 「包被覆盖」「测试跑到别人的版本上」「截图与需求对不上」这类
 * 极难排查的问题。所以设备必须像工作区一样被显式分配。
 *
 * 平台差异只在这三件事上：怎么列设备、怎么判断在线、怎么描述类型。
 * 构建和装包命令不在这里——那些随项目走，写在 bot.config.json 的 envHints 里。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 各平台的设备发现方式 */
export const PLATFORMS = {
  harmony: {
    label: '鸿蒙',
    /** @returns {{id: string, state: string}[]} */
    list(tools = {}) {
      const bin = tools.hdc ?? 'hdc'
      const out = run(bin, ['list', 'targets'])
      if (!out) return []
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^\[Empty\]$/i.test(l) && !/hdc$/i.test(l))
        .map((id) => ({ id, state: 'device' }))
    },
  },

  android: {
    label: 'Android',
    list(tools = {}) {
      const bin = tools.adb ?? 'adb'
      const out = run(bin, ['devices'])
      if (!out) return []
      return out
        .split('\n')
        .slice(1) // 第一行是 "List of devices attached"
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [id, state] = l.split(/\s+/)
          return { id, state }
        })
        .filter((d) => d.id && d.state === 'device')
    },
  },

  ios: {
    label: 'iOS',
    list(tools = {}) {
      const bin = tools.xcrun ?? 'xcrun'
      const out = run(bin, ['simctl', 'list', 'devices', 'booted'])
      if (!out) return []
      const devices = []
      for (const line of out.split('\n')) {
        // 形如：    iPhone 15 (A1B2-C3D4) (Booted)
        const m = line.match(/^\s+(.+?)\s+\(([0-9A-F-]{20,})\)\s+\(Booted\)/i)
        if (m) devices.push({ id: m[2], name: m[1], state: 'device' })
      }
      return devices
    },
  },
}

function run(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim()
  } catch {
    return ''
  }
}

/**
 * 列出可用设备。配置里给了 devices 就用配置的（跳过自动发现），
 * 否则按平台自动探测——探测不到就返回空，由调用方决定是报错还是跳过。
 */
export function listDevices(config) {
  const platform = config.platform ?? 'harmony'
  const adapter = PLATFORMS[platform]
  if (!adapter) return { ok: false, error: `不认识的平台：${platform}`, devices: [] }

  if (Array.isArray(config.devices) && config.devices.length) {
    const devices = config.devices
      .map((d) => (typeof d === 'string' ? { id: d } : d))
      .filter((d) => d?.id)
      .map((d) => ({ id: d.id, name: d.name ?? null, state: 'device' }))
    return { ok: true, platform, label: adapter.label, devices, source: 'config' }
  }

  const devices = adapter.list(config.tools ?? {})
  return {
    ok: true,
    platform,
    label: adapter.label,
    devices,
    source: 'auto',
    // 自动发现为空不是错误：有些阶段根本不需要设备，由调用方按 needed 决定
    empty: devices.length === 0,
  }
}

/**
 * 设备池：每台设备一把独占锁，谁抢到谁用。
 *
 * 和 worktree 池的区别：worktree 是「总量型」资源（12 个名额，谁占都行），
 * 设备是「指定型」资源（必须指定哪一台，因为装包和跑测试都绑定到具体设备）。
 */
export class DevicePool {
  constructor({ lockDir, platform, devices }) {
    this.lockDir = lockDir
    this.platform = platform
    this.devices = devices
    this.mkdir()
  }

  mkdir() {
    try {
      mkdirSync(this.lockDir, { recursive: true })
    } catch {
      /* 已存在 */
    }
  }

  /** 设备 id 里有冒号点号，做文件名要转义 */
  #file(deviceId) {
    return join(this.lockDir, `dev-${deviceId.replace(/[^\w.-]/g, '_')}.lock`)
  }

  #alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return err.code === 'EPERM'
    }
  }

  /** 清掉死进程留下的设备锁 */
  #sweep() {
    for (const name of this.#readEntries()) {
      const file = join(this.lockDir, name)
      try {
        const info = JSON.parse(readFileSync(file, 'utf8'))
        if (!this.#alive(info.pid)) unlinkSync(file)
      } catch {
        try {
          unlinkSync(file)
        } catch {
          /* ignore */
        }
      }
    }
  }

  #readEntries() {
    try {
      return readdirSync(this.lockDir)
    } catch {
      return []
    }
  }

  /** 每台设备当前被谁占着（面板展示用） */
  status() {
    this.#sweep()
    const held = new Map()
    for (const name of this.#readEntries()) {
      try {
        const info = JSON.parse(readFileSync(join(this.lockDir, name), 'utf8'))
        held.set(info.deviceId ?? name, info)
      } catch {
        /* ignore */
      }
    }
    return this.devices.map((d) => ({
      id: d.id,
      name: d.name ?? null,
      busy: held.has(d.id),
      holder: held.get(d.id)?.reqId ?? null,
    }))
  }

  /**
   * 抢一台空闲设备。
   * @returns {{ok:true, deviceId:string, release:Function} | {ok:false, reason:string}}
   */
  tryAcquire({ reqId = '', stage = '' } = {}) {
    this.#sweep()
    if (!this.devices.length) return { ok: false, reason: '没有可用设备' }

    for (const d of this.devices) {
      const file = this.#file(d.id)
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid, deviceId: d.id, reqId, stage, at: Date.now() }), {
          flag: 'wx', // 原子：已存在就抛 EEXIST
        })
        return {
          ok: true,
          deviceId: d.id,
          release: () => {
            try {
              unlinkSync(file)
            } catch {
              /* 已被清理 */
            }
          },
        }
      } catch (err) {
        if (err.code !== 'EEXIST') return { ok: false, reason: err.message }
        // 被占：试下一台
      }
    }
    return { ok: false, reason: '所有设备都在忙' }
  }

  /** 等一台设备空闲（超时返回 null） */
  async acquire({ waitMs = 60 * 60 * 1000, pollMs = 2000, reqId = '', stage = '' } = {}) {
    const deadline = Date.now() + waitMs
    for (;;) {
      const r = this.tryAcquire({ reqId, stage })
      if (r.ok) return r
      if (r.reason === '没有可用设备') return null
      if (Date.now() >= deadline) return null
      await new Promise((res) => setTimeout(res, pollMs))
    }
  }
}
