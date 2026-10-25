/**
 * 状态机：一个群 = 一个需求会话。
 *
 * 关键约束：
 * - 同一群同一时刻只允许一个回合在跑（否则两个回合会抢写同一份技术方案）
 * - 续跑必须带同一个 sessionId，否则上下文全丢
 * - 状态落盘到 .state/，bridge 重启后还能接着聊
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const IDLE = 'idle'
const RUNNING = 'running'
const WAITING = 'waiting'

export class SessionStore {
  constructor(repoRoot) {
    this.dir = join(repoRoot, '.state')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
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
    writeFileSync(this.#file(groupId), JSON.stringify(state, null, 2), 'utf8')
  }

  clear(groupId) {
    const f = this.#file(groupId)
    if (existsSync(f)) writeFileSync(f, '{}', 'utf8')
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
   * 解析一个群该不该处理、用哪个项目。
   * 群号不用手填：auto 模式下任何群都接受，路径用顶层 projectDir；
   * 想排除个别群用 excludeGroups，不必退回 allowlist。
   * @returns {{ok: boolean, reason?: string, groupId: string, projectDir?: string, approval?: string}}
   */
  resolveGroup(groupId) {
    const policy = this.config.groupPolicy?.mode ?? 'auto'

    if (policy === 'deny') {
      return { ok: false, reason: 'groupPolicy.mode=deny，已拒绝所有群', groupId }
    }

    // 排除名单优先于任何策略：个人闲聊群不该被 bot 掺和
    if (this.config.excludeGroups?.includes(groupId)) {
      return { ok: false, reason: '在 excludeGroups 排除名单里', groupId }
    }

    const listed = this.config.groups.find((x) => x.groupId === groupId)

    if (listed) {
      return { ok: true, groupId, projectDir: listed.projectDir, approval: listed.approval }
    }

    if (policy === 'allowlist') {
      return { ok: false, reason: '不在 groups 白名单里', groupId }
    }

    // auto：未在 groups 中列出的群沿用顶层配置
    return {
      ok: true,
      groupId,
      projectDir: this.config.projectDir,
      approval: this.config.approval ?? 'manual',
    }
  }

  /** 读取持久状态，缺省时按群策略初始化 */
  peek(groupId) {
    const g = this.resolveGroup(groupId)
    if (!g.ok) return null

    const saved = this.store.get(groupId)
    return {
      groupId,
      projectDir: saved?.projectDir ?? g.projectDir,
      approval: g.approval,
      sessionId: saved?.sessionId ?? null,
      status: saved?.status ?? IDLE,
      waitingLabel: saved?.waitingLabel ?? '',
      turn: saved?.turn ?? 0,
      lastActiveAt: saved?.lastActiveAt ?? 0,
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
  enqueue(groupId, text) {
    const slot = this.#slot(groupId)
    slot.queue.push(text)
    return slot.queue.length
  }

  drainQueue(groupId) {
    const slot = this.#slot(groupId)
    const q = slot.queue.slice()
    slot.queue.length = 0
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
