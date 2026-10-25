/**
 * 运行时状态：面板要的一切「内存里的东西」都在这里收口。
 *
 * 之前这些散落在 handleTurn 的闭包里（turnDone、子进程 pid、最后事件时间），
 * 外面看不到。现在集中维护，可随时 snapshot 成 JSON 给 /api/status。
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const RING_MAX = 500

export class Runtime {
  /** @param {{logDir: string, verbose?: boolean}} opts */
  constructor({ logDir, verbose = false }) {
    this.verbose = verbose
    this.logDir = logDir
    this.startedAt = Date.now()

    /** @type {{at:number, level:string, text:string}[]} */
    this.ring = []
    /** @type {Map<string, {startedAt:number, childPid:number|null, lastEventAt:number, events:number}>} */
    this.turns = new Map()

    this.#ensureLogFile()
  }

  #logStream = null
  #logDate = ''

  #ensureLogFile() {
    const day = new Date().toISOString().slice(0, 10)
    if (this.#logDate === day && this.#logStream) return
    try {
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true })
      this.#logStream?.end()
      this.#logStream = createWriteStream(join(this.logDir, `bridge-${day}.log`), { flags: 'a' })
      this.#logDate = day
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }

  /**
   * 记一条日志：控制台 + 环形缓冲 + 按天落盘。
   * 面板的「最近日志」和终端看到的是同一份。
   */
  log(level, ...parts) {
    const text = parts.join(' ')
    const at = Date.now()
    this.ring.push({ at, level, text })
    if (this.ring.length > RING_MAX) this.ring.shift()

    const line = `${new Date(at).toLocaleTimeString('zh-CN')} ${level === 'info' ? '' : `[${level}] `}${text}`
    console.log(line)

    try {
      this.#ensureLogFile()
      this.#logStream?.write(
        `${new Date(at).toISOString()} ${level} ${text.replace(/\n/g, '\\n')}\n`,
      )
    } catch {
      /* ignore */
    }
  }

  info(...parts) {
    this.log('info', ...parts)
  }

  warn(...parts) {
    this.log('warn', ...parts)
  }

  error(...parts) {
    this.log('error', ...parts)
  }

  /** 回合开始：记下子进程 pid 与起始时间 */
  beginTurn(groupId, { childPid = null } = {}) {
    this.turns.set(String(groupId), {
      startedAt: Date.now(),
      childPid,
      lastEventAt: Date.now(),
      events: 0,
    })
  }

  /** agent 有事件（text/工具调用/状态）→ 刷新「最后活动」 */
  noteEvent(groupId) {
    const t = this.turns.get(String(groupId))
    if (!t) return
    t.lastEventAt = Date.now()
    t.events += 1
  }

  endTurn(groupId) {
    this.turns.delete(String(groupId))
  }

  /** 某群当前回合的实时信息；没有回合时返回 null */
  turnInfo(groupId) {
    const t = this.turns.get(String(groupId))
    if (!t) return null
    let childAlive = false
    if (t.childPid) {
      try {
        process.kill(t.childPid, 0)
        childAlive = true
      } catch {
        childAlive = false
      }
    }
    return {
      startedAt: t.startedAt,
      elapsedMs: Date.now() - t.startedAt,
      idleMs: Date.now() - t.lastEventAt,
      events: t.events,
      childPid: t.childPid,
      childAlive,
    }
  }

  /** 进程资源占用 */
  resources() {
    const m = process.memoryUsage()
    const cpu = process.cpuUsage()
    const cpuPct = ((cpu.user + cpu.system) / 1000 / Math.max(1, Date.now() - this.startedAt)) * 100
    return {
      rssMb: +(m.rss / 1024 / 1024).toFixed(1),
      heapMb: +(m.heapUsed / 1024 / 1024).toFixed(1),
      externalMb: +(m.external / 1024 / 1024).toFixed(1),
      cpuPct: +cpuPct.toFixed(2),
      uptimeMs: Date.now() - this.startedAt,
    }
  }

  /** 最近的日志（面板用） */
  recentLogs(n = 100, level) {
    const list = level ? this.ring.filter((x) => x.level === level) : this.ring
    return list.slice(-n)
  }

  close() {
    try {
      this.#logStream?.end()
    } catch {
      /* ignore */
    }
  }
}
