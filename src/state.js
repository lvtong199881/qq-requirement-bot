/**
 * 状态机：一个会话（App 里的一个需求）= 一份状态。
 *
 * 变量名里还带着 group（groupId/allGroupIds）是历史包袱：这套机器原本是按
 * QQ 群号索引的，后来 App 的 threadId 直接复用同一个字段（它自始至终只是
 * 一个不透明的字符串键）。改名要动 296 处、跨 14 个文件，纯属给 review
 * 添噪音，行为收益为零——所以留着名字，改的是语义。
 *
 * 关键约束：
 * - 同一会话同一时刻只允许一个回合在跑（否则两个回合会抢写同一份技术方案）
 * - 续跑必须带同一个 sessionId，否则上下文全丢
 * - 状态落盘到 .state/，bridge 重启后还能接着聊
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const IDLE = 'idle'
const RUNNING = 'running'
const WAITING = 'waiting'

export class SessionStore {
  /**
   * @param {string} repoRoot  仓库根，默认把状态放在 <repoRoot>/.state
   * @param {string} [dir]     显式指定状态目录（测试用：不能往真实 .state 里写账号）
   */
  constructor(repoRoot, dir) {
    this.dir = dir || join(repoRoot, '.state')
    this.#ensureDir()
  }

  /** 每次写盘前都确保目录存在：运行中被人删掉也不会 ENOENT */
  #ensureDir() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    } catch {
      /* 真建不了就让后续写入报错，至少错误发生在明确的位置 */
    }
  }

  #file(groupId) {
    return join(this.dir, `group-${groupId}.json`)
  }

  get(groupId) {
    const f = this.#file(groupId)
    if (!existsSync(f)) return null
    try {
      return JSON.parse(readFileSync(f, 'utf8'))
    } catch {
      return null
    }
  }

  save(groupId, state) {
    this.#ensureDir()
    const file = this.#file(groupId)
    // 先写临时文件再 rename：rename 在同一文件系统上是原子的。
    // 直接 writeFileSync 如果进程在写一半被杀（或断电），会留下残缺 JSON，
    // 下次 get() 解析失败就当成「这个群没跑过」——流程状态静默丢失。
    // 用临时文件最坏情况是保留上一次成功的状态，而不是产生垃圾。
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  clear(groupId) {
    this.#ensureDir()
    const f = this.#file(groupId)
    if (existsSync(f)) writeFileSync(f, '{}', 'utf8')
  }

  /** 所有落过盘的群 id（含被 clear 成 {} 的），供启动清理用 */
  allGroupIds() {
    this.#ensureDir()
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith('group-') && f.endsWith('.json'))
        .map((f) => f.slice('group-'.length, -'.json'.length))
    } catch {
      return []
    }
  }
}

export class GroupStateMachine {
  constructor(config, store) {
    this.config = config
    this.store = store
    /** @type {Map<string, {running:boolean, aborter:AbortController|null, queue:string[]}>} */
    this.active = new Map()
  }

  #slot(groupId) {
    let s = this.active.get(groupId)
    if (!s) {
      s = { running: false, aborter: null, queue: [] }
      this.active.set(groupId, s)
    }
    return s
  }

  /**
   * 解析一个会话用哪个项目、什么批准方式。
   *
   * 以前这里有三种群策略（auto/allowlist/deny）加一份 groups 白名单，
   * 都是为了回答「这个群该不该服务」。现在会话由 App 创建、身份由用户表
   * 决定，没有「陌生群」这回事，策略层整个不需要了。
   * 保留这个方法是给编排层一个统一的入口：将来若要按需求类型分项目，
   * 改这里就够，不用再翻 flow-bridge。
   *
   * @returns {{ok: boolean, groupId: string, projectDir?: string, approval?: string}}
   */
  resolveGroup(groupId) {
    return {
      ok: true,
      groupId,
      projectDir: this.config.projectDir,
      approval: this.config.approval ?? 'manual',
    }
  }

  /** 列出所有「落过盘」的会话状态——面板要遍历的就是这些。 */
  listAll() {
    const out = []
    for (const id of this.store.allGroupIds()) {
      const st = this.peek(id)
      if (st) out.push(st)
    }
    return out
  }

  /** 读取持久状态，缺省时按群策略初始化 */
  peek(groupId) {
    const g = this.resolveGroup(groupId)
    if (!g.ok) return null

    const saved = this.store.get(groupId)
    return {
      groupId,
      // 群名。建群时由 API 写盘，需求名（flow.name）是另一回事：
      // 群是容器、需求是里面跑的那件事，两者不能混用一个字段。
      name: saved?.name ?? null,
      // 群模式：chat 只是聊天，requirement 是「跑过需求」的群（不 @ bot 仍只是聊天）。
      // 必须在这里回读：编排层每回合都会拿 peek() 的结果整份写回盘，
      // 少读一个字段就等于「谁最后 save 谁把模式抹成默认值」。
      mode: saved?.mode ?? 'chat',
      projectDir: saved?.projectDir ?? g.projectDir,
      approval: g.approval,
      // 绑定过的需求标识。以前没回读这一行：写进盘里的 reqId 每次都被丢掉，
      // 所有判定只能退化成「读最近的编排记录」——新群因此会认领到别人的需求，
      // 一 @ 就被告知「本需求已全部完成」。
      // 反过来，旧版本把这个猜来的 reqId 写回了盘：turn=0 且没有 sessionId
      // 说明这个群从没真跑过回合，那样的绑定不是用户建的，读的时候丢掉。
      reqId: saved?.turn || saved?.sessionId ? (saved?.reqId ?? null) : null,
      sessionId: saved?.sessionId ?? null,
      status: saved?.status ?? IDLE,
      waitingLabel: saved?.waitingLabel ?? '',
      turn: saved?.turn ?? 0,
      lastActiveAt: saved?.lastActiveAt ?? 0,
      // 阶段播报用：当前进行中的阶段、它的开始时间、已知完成的阶段
      stage: saved?.stage ?? null,
      stageStartedAt: saved?.stageStartedAt ?? 0,
      finishedStages: saved?.finishedStages ?? null, // null=首次，历史阶段不播报
      // 最近一次在这群里提需求的人（面板列表要显示「发起人」）
      initiator: saved?.initiator ?? null,
      // 打回后等用户补充修改意见
      pendingReject: saved?.pendingReject ?? null,
      // /release 等二次确认
      pendingRelease: saved?.pendingRelease ?? null,
      // v2 编排状态：checkpoint、返工计数、roleSessions、等待事项全在里面。
      // 和上面那批旧字段并存，v1 读旧的、v2 读这个，互不影响。
      flow: saved?.flow ?? null,
    }
  }

  isRunning(groupId) {
    return this.#slot(groupId).running
  }

  /** 标记进入运行态，返回 release 函数 */
  acquire(groupId, aborter) {
    const slot = this.#slot(groupId)
    if (slot.running) return null
    slot.running = true
    slot.aborter = aborter
    return () => {
      slot.running = false
      slot.aborter = null
    }
  }

  /** 用户在运行中插话：排队，等本回合结束再处理 */
  /**
   * 排队一条消息。同时写进 state 文件——bridge 重启时内存队列会丢，
   * 落盘之后至少能在下次启动时告诉用户「这几条没执行，请重发」。
   */
  enqueue(groupId, text) {
    const slot = this.#slot(groupId)
    slot.queue.push(text)
    const st = this.store.get(groupId)
    if (st) this.store.save(groupId, { ...st, queued: [...(st.queued ?? []), text] })
    return slot.queue.length
  }

  /** 读持久化的待执行消息（重启后用来提示用户） */
  pendingQueued(groupId) {
    const st = this.store.get(groupId)
    return Array.isArray(st?.queued) ? st.queued : []
  }

  /** 清掉持久化的待执行消息 */
  clearQueued(groupId) {
    const st = this.store.get(groupId)
    if (!st) return
    if (!st.queued) return
    const { queued, ...rest } = st
    this.store.save(groupId, rest)
  }

  drainQueue(groupId) {
    const slot = this.#slot(groupId)
    const q = slot.queue.slice()
    slot.queue.length = 0
    this.clearQueued(groupId)
    return q
  }

  /** 主动打断当前回合（用户发「停」） */
  interrupt(groupId) {
    const slot = this.#slot(groupId)
    if (!slot.running || !slot.aborter) return false
    slot.aborter.abort()
    return true
  }
}

export const STATES = { IDLE, RUNNING, WAITING }
