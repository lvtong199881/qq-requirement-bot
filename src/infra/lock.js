/**
 * 跨平台的进程间互斥：文件锁 + 计数信号量。
 *
 * 为什么不用 `flock` 命令：macOS 没有它（Linux 才有）。所以用「独占创建锁文件」——
 * `openSync(path, 'wx')` 在 POSIX 上是原子操作，谁创建成功谁持有。
 *
 * 僵尸锁怎么处理：锁文件里写 pid 和心跳时间戳。持锁进程死了（pid 不存在）或心跳过期，
 * 后来者可以抢占。这样进程被 kill -9 也不会永久卡住。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** 默认锁有效期（毫秒）。合并操作是秒级的，5 分钟足够宽松 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

function ensureParent(file) {
  const dir = file.slice(0, file.lastIndexOf('/'))
  if (dir) mkdirSync(dir, { recursive: true })
}

/** 进程是否还活着（权限不足也算活着，保守处理） */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function readLockInfo(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 锁是否已失效：进程死了，或心跳太旧 */
function isStale(info, ttlMs) {
  if (!info) return true
  if (!pidAlive(info.pid)) return true
  const age = Date.now() - Number(info.at ?? 0)
  return age > ttlMs
}

/**
 * 尝试获取互斥锁，拿不到立刻返回（不阻塞）。
 * @returns {{ok:true, release:Function} | {ok:false, holder:{pid:number, at:number}|null}}
 */
export function tryAcquireLock(file, { ttlMs = DEFAULT_TTL_MS } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      ensureParent(file)
      const fd = openSync(file, 'wx') // 原子：已存在就抛 EEXIST
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      closeSync(fd)
      return {
        ok: true,
        release: () => {
          try {
            unlinkSync(file)
          } catch {
            /* 已经不在了 */
          }
        },
      }
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: false, holder: null, error: err.message }

      const info = readLockInfo(file)
      if (!isStale(info, ttlMs)) return { ok: false, holder: info }

      // 僵尸锁：清掉再抢一次。多个进程同时抢时，只有一个能 create 成功
      try {
        unlinkSync(file)
      } catch {
        /* 别人先清了 */
      }
    }
  }
  return { ok: false, holder: readLockInfo(file) }
}

/**
 * 获取互斥锁，拿不到就等（带超时）。
 * @returns {{ok:true, release:Function} | {ok:false, timeout:true, holder:any}}
 */
export async function acquireLock(file, { ttlMs = DEFAULT_TTL_MS, waitMs = 60_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const r = tryAcquireLock(file, { ttlMs })
    if (r.ok) return r
    if (Date.now() >= deadline) return { ok: false, timeout: true, holder: r.holder }
    await new Promise((res) => setTimeout(res, pollMs))
  }
}

/** 持锁执行一段逻辑，结束后自动释放 */
export async function withLock(file, fn, opts = {}) {
  const lock = await acquireLock(file, opts)
  if (!lock.ok) return { ok: false, timeout: true, holder: lock.holder }
  try {
    return { ok: true, value: await fn() }
  } finally {
    lock.release()
  }
}

/**
 * 计数信号量：用「一个文件 = 一个占位」实现。
 *
 * 用途：worktree 池（同时最多 N 个开发中需求）、执行槽（同时最多 N 个回合）。
 * 进程崩溃后残留的占位文件会按 pid 存活情况清理，不会永久占着名额。
 */
export class SlotPool {
  constructor(dir, max) {
    this.dir = dir
    this.max = Math.max(1, Number(max) || 1)
  }

  #entries() {
    try {
      return readdirSync(this.dir)
    } catch {
      return []
    }
  }

  /** 清理死进程留下的占位，返回存活数量 */
  #sweep() {
    let alive = 0
    for (const name of this.#entries()) {
      const file = join(this.dir, name)
      const info = readLockInfo(file)
      if (!info || !pidAlive(info.pid) || Date.now() - Number(info.at ?? 0) > DEFAULT_TTL_MS) {
        try {
          unlinkSync(file)
        } catch {
          /* 别人已经清了 */
        }
        continue
      }
      alive++
    }
    return alive
  }

  /** 当前占用 / 上限 */
  stats() {
    return { used: this.#sweep(), max: this.max }
  }

  /**
   * 申请一个槽位。拿不到返回 null（调用方负责排队）。
   * @returns {{ok:true, release:Function} | null}
   */
  tryAcquire(tag = '') {
    mkdirSync(this.dir, { recursive: true })
    if (this.#sweep() >= this.max) return null

    const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}${tag ? '-' + tag : ''}`
    const file = join(this.dir, name)
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), tag }))
      closeSync(fd)
    } catch {
      return null
    }

    return {
      ok: true,
      stats: () => this.stats(),
      release: () => {
        try {
          unlinkSync(file)
        } catch {
          /* 已经没了 */
        }
      },
    }
  }

  /** 等到有空位（或超时返回 null） */
  async acquire({ waitMs = 120_000, pollMs = 500, tag = '' } = {}) {
    const deadline = Date.now() + waitMs
    for (;;) {
      const slot = this.tryAcquire(tag)
      if (slot) return slot
      if (Date.now() >= deadline) return null
      await new Promise((res) => setTimeout(res, pollMs))
    }
  }

  /** 第几位（排队位置，用于告诉用户「前面还有几个」） */
  position() {
    return Math.max(0, this.#sweep() - this.max + 1)
  }
}

/** 清理某个目录下所有占位文件（运维用） */
export function clearPool(dir) {
  for (const name of readdirSync(dir)) {
    try {
      unlinkSync(join(dir, name))
    } catch {
      /* ignore */
    }
  }
}

/** 锁文件是否存在（面板展示用） */
export function lockExists(file) {
  return existsSync(file)
}
