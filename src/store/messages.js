/**
 * 消息存储：每个需求一条 JSONL 文件。
 *
 * 为什么不用 SQLite：
 *   node:sqlite 在 Node 24 还是 experimental，启动会打 ExperimentalWarning；
 *   Node 22 上要手动加 --experimental-sqlite 标志，用户复制过去就崩。
 *   而现在的查询需求只有三个——按 thread 拉消息、算未读数、按 seq 增量拉，
 *   JSONL 顺序追加天然满足，还省掉整个依赖。
 *   真要做全文检索时再换，那时候查询模式才值得一个数据库。
 *
 * 为什么每个 thread 一个文件，而不是一个大文件：
 *   App 只拉当前打开的这条需求，分文件可以直接只读那个文件；
 *   大文件则每次都要跳过别的内容。删除需求也只是一次 unlink。
 *
 * 行格式（一行一条，便于 tail -f 直接看）：
 *   {"seq":1,"at":1690000000000,"role":"bot","kind":"text","payload":{"text":"..."}}
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 单条消息文本上限：和 bot 的 chunkChars 同量级，超出的截断而不是拒绝 */
const MAX_TEXT = 20000

export class MessageStore {
  /** @param {string} dir 落盘目录，通常是 join(repoRoot, '.state', 'messages') */
  constructor(dir) {
    this.dir = dir
    /** @type {Map<string, number>} thread → 已分配的最大 seq，懒加载 */
    this.seqCache = new Map()
    this.#ensureDir()
  }

  #ensureDir() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    } catch {
      /* 真建不了让后续写入报错 */
    }
  }

  /**
   * thread id 会进文件名，必须挡住路径穿越。
   * 不是「防攻击者」——调用方是自家 bridge——而是防一个含 `/` 的
   * groupId 把消息写到意料之外的目录去。
   */
  #file(threadId) {
    const safe = String(threadId).replace(/[^A-Za-z0-9._-]/g, '_')
    return join(this.dir, `${safe}.jsonl`)
  }

  /** 读文件里最大的 seq。文件不存在返回 0 */
  #lastSeq(threadId) {
    if (this.seqCache.has(threadId)) return this.seqCache.get(threadId)
    const file = this.#file(threadId)
    let last = 0
    try {
      if (existsSync(file)) {
        const text = readFileSync(file, 'utf8')
        // 从后往前找第一个能解析出 seq 的行，比逐行 JSON.parse 整文件快得多
        const lines = text.trimEnd().split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i]) continue
          try {
            const row = JSON.parse(lines[i])
            if (typeof row.seq === 'number') {
              last = row.seq
              break
            }
          } catch {
            /* 坏行跳过，继续往前找 */
          }
        }
      }
    } catch {
      last = 0
    }
    this.seqCache.set(threadId, last)
    return last
  }

  /**
   * 追加一条消息。同步写：Node 单线程下同步 append 天然原子，
   * 异步写反而要自己维护顺序，一条消息乱序在聊天界面上很显眼。
   *
   * @returns {{seq:number, at:number, role:string, kind:string, payload:object}}
   */
  append(threadId, { role = 'bot', kind = 'text', payload = {}, at = Date.now() }) {
    this.#ensureDir()
    const seq = this.#lastSeq(threadId) + 1
    const clean = sanitizePayload(kind, payload)
    const row = { seq, at, role, kind, payload: clean }

    const file = this.#file(threadId)
    try {
      writeFileSync(file, `${JSON.stringify(row)}\n`, { flag: 'a', encoding: 'utf8' })
      this.seqCache.set(threadId, seq)
    } catch (err) {
      // 落盘失败不能静默：App 那边会以为消息丢了。抛出去让调用方记日志。
      throw new Error(`消息落盘失败（${threadId} #${seq}）：${err.message}`)
    }
    return row
  }

  /**
   * 拉消息。
   * @param {string} threadId
   * @param {{since?:number, limit?:number, before?:number}} opts
   *   since  只返回 seq > since 的（增量拉，App 轮询用）
   *   before 只返回 seq < before 的（往上翻历史用）
   *   limit  最多返回多少条，默认 200，超出时取**最新**的 limit 条
   */
  list(threadId, { since = 0, before = Infinity, limit = 200 } = {}) {
    const file = this.#file(threadId)
    if (!existsSync(file)) return { messages: [], lastSeq: 0 }

    let rows = []
    try {
      const text = readFileSync(file, 'utf8')
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          const row = JSON.parse(line)
          if (typeof row.seq !== 'number') continue
          if (row.seq <= since) continue
          if (row.seq >= before) continue
          rows.push(row)
        } catch {
          /* 单行损坏不该让整个会话读不出来 */
        }
      }
    } catch {
      return { messages: [], lastSeq: 0 }
    }

    // 翻历史时要的是「最近 N 条」，不是「最早 N 条」
    if (rows.length > limit) rows = rows.slice(-limit)
    return { messages: rows, lastSeq: this.#lastSeq(threadId) }
  }

  /** 未读数：App 列表页的角标。只数 bot 发的、比用户最后阅读位置新的 */
  lastSeq(threadId) {
    return this.#lastSeq(threadId)
  }

  /** 删除该需求的全部消息。取消/归档需求时调用 */
  clear(threadId) {
    const file = this.#file(threadId)
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {
      /* ignore */
    }
    this.seqCache.delete(threadId)
  }

  /** 启动时列出现有 thread，清理孤儿用 */
  threadIds() {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -'.jsonl'.length))
    } catch {
      return []
    }
  }
}

/**
 * 按 kind 收敛 payload 形状，顺便挡住超大文本。
 *
 * 为什么要收敛：payload 会被原样塞进 JSON 返回给 App。如果哪天有人
 * 往里塞了 Buffer 或循环引用，JSON.stringify 会抛错把整个响应搞挂；
 * 这里只放行明确认识的字段，其余一律丢掉。
 */
function sanitizePayload(kind, payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const out = {}
  const text = typeof p.text === 'string' ? p.text : ''
  if (text) out.text = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…（已截断）` : text

  // 提到谁：@需求bot 是「这句话要不要交给引擎」的判据，
  // 但显示上也用得到（气泡里高亮），所以按文本消息的附加字段放行
  if (Array.isArray(p.mentions)) {
    const ids = p.mentions.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20)
    if (ids.length) out.mentions = ids
  }

  // 谁说的：群里不止一个人说话，右侧气泡只能靠 id 判断「是不是我」，
  // 靠昵称判断会被同名的人冒充；昵称只用来显示
  if (typeof p.userId === 'string' && p.userId) out.userId = p.userId
  if (typeof p.nickname === 'string' && p.nickname) out.nickname = p.nickname.slice(0, 32)

  switch (kind) {
    case 'image':
      if (typeof p.url === 'string') out.url = p.url
      if (typeof p.name === 'string') out.name = p.name
      // 大小给 App 显示「12.3 MB」，也让「这张图多长」在文本旁能看出来
      if (typeof p.size === 'number') out.size = p.size
      break
    case 'file':
      if (typeof p.url === 'string') out.url = p.url
      if (typeof p.name === 'string') out.name = p.name
      if (typeof p.size === 'number') out.size = p.size
      break
    case 'stage':
      // 阶段变化卡片：App 侧画成一条系统提示，不是气泡
      if (typeof p.stage === 'string') out.stage = p.stage
      if (typeof p.status === 'string') out.status = p.status
      break
    case 'decision':
      // 待决策卡片：通过/打回按钮就挂在这条消息下面
      if (typeof p.title === 'string') out.title = p.title
      if (Array.isArray(p.items)) out.items = p.items.map(String).slice(0, 20)
      break
    default:
      break
  }
  return out
}
