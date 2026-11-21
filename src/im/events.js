/**
 * 给需求引擎的事件队列。
 *
 * 为什么落盘而不是放内存：IM 和引擎拆到两台机器后，引擎可能重启、断网、
 * 被人手动停掉。存内存的话这期间用户 @ 的需求就静默消失了——用户以为
 * 提了，实际什么都没发生，这是最难排查的一类问题。落成 JSONL 后引擎按
 * 游标补读，最多是晚几分钟开始跑。
 *
 * 不引数据库：量级是「人说话的速度」，一天几千行，读全文再过滤完全够用。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 内存里保留的最近事件数。文件不删，引擎游标落后太多时还能人工捞 */
const MAX_KEEP = 2000

export class EngineEvents {
  /** @param {string|null} dir 为空则只在内存里排队（单机模式够用） */
  constructor(dir = null) {
    this.dir = dir
    this.file = dir ? join(dir, 'events.jsonl') : null
    /** @type {object[]} */
    this.list = []
    /** @type {Set<{after:number, resolve:(v:object[])=>void, timer:any}>} */
    this.waiters = new Set()
    if (this.file) this.#load()
  }

  #load() {
    let raw = ''
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return // 第一次启动没有文件
    }
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        this.list.push(JSON.parse(text))
      } catch {
        // 进程在写的时候被杀过，最后一行可能是半截 JSON。
        // 丢掉这行就够了，不能因为一行坏了就让整个 IM 起不来。
      }
    }
    if (this.list.length > MAX_KEEP) this.list = this.list.slice(-MAX_KEEP)
  }

  /** 最新一条事件的号。引擎下次轮询带回来的 after 就是它 */
  get cursor() {
    return this.list.length ? this.list[this.list.length - 1].seq : 0
  }

  /**
   * 记一条事件。
   *
   * @param {'start'|'message'|'group'} type
   *        start: 群里第一句 @机器人账号，要开需求
   *        message: 需求群里的普通发言
   *        group: 群建好/改名，引擎可能想更新自己的目录
   */
  append(type, payload = {}) {
    const ev = { seq: this.cursor + 1, at: Date.now(), type, ...payload }
    this.list.push(ev)
    if (this.list.length > MAX_KEEP) this.list.shift()
    if (this.file) {
      try {
        mkdirSync(this.dir, { recursive: true })
        appendFileSync(this.file, `${JSON.stringify(ev)}\n`)
      } catch {
        // 写盘失败不影响本次会话：内存里还有，引擎这次轮询照样能拿到。
        // 只是重启后会丢，属于可接受的降级。
      }
    }
    for (const w of [...this.waiters]) {
      const hit = this.list.filter((e) => e.seq > w.after)
      if (hit.length) w.finish(hit)
    }
    return ev
  }

  /** 游标之后的所有事件 */
  since(after = 0) {
    const n = Number(after) || 0
    return this.list.filter((e) => e.seq > n)
  }

  /**
   * 等到有 `after` 之后的新事件，最多等 `timeoutMs`。
   *
   * 长轮询的等待端在 IM 这边：引擎那边只要一直挂着 GET，用户一说话
   * 立刻就能收到，不用每秒拉一次。超时返回空数组，让引擎知道连接还活着。
   */
  waitFor(after = 0, timeoutMs = 25_000) {
    const now = this.since(after)
    if (now.length) return Promise.resolve(now)
    return new Promise((resolve) => {
      const waiter = {
        after: Number(after) || 0,
        finish: (events) => {
          clearTimeout(waiter.timer)
          this.waiters.delete(waiter)
          resolve(events)
        },
      }
      // 连接断掉（引擎主动断开）时不清 waiter 的话会一直挂着，
      // 靠定时器兜底，最多多占一会儿内存。
      waiter.timer = setTimeout(() => waiter.finish([]), timeoutMs)
      this.waiters.add(waiter)
    })
  }

  /** 进程退出前把等待中的长轮询放掉，否则服务端会话一直挂着 */
  close() {
    for (const w of [...this.waiters]) w.finish([])
  }
}
