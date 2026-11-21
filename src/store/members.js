/**
 * 群成员存储：群从「所有人可见」变成「加入才能看」之后，
 * 谁是成员、谁是群管理员必须落盘。
 *
 * 为什么单独一个文件，而不是塞进 group-<id>.json：
 * 群状态文件每跑一个回合都会被状态机整份重写（peek() 拼装出来的字段
 * 就是全部），少读一个字段就等于谁最后 save 谁把成员抹掉——mode 已经
 * 踩过一次这个坑。成员是「人」的数据，和回合状态生命周期不同，
 * 分开存谁也写不坏谁。
 *
 * 为什么群主也存一份 role：权限判断要一处问「这个人能改群名吗」，
 * 不希望调用方还要先比一遍 group.initiator.userId。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MEMBER_ROLES = { owner: 'owner', admin: 'admin', member: 'member' }

/** 角色权重：列表排序用（群主永远排第一） */
const ROLE_RANK = { owner: 0, admin: 1, member: 2 }

export class MemberStore {
  /** @param {string} dir 通常是 join(stateDir, 'members') */
  constructor(dir) {
    this.dir = dir
    this.#ensureDir()
  }

  #ensureDir() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    } catch {
      /* 真建不了让后续写入报错，别在这里吞成一个假成功 */
    }
  }

  /** threadId 可能来自 URL，进文件名前收敛成安全字符 */
  #file(threadId) {
    return join(this.dir, `members-${String(threadId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  }

  /**
   * 读一个群的成员表。文件不存在返回 null——null 和「空群」是两件事：
   * null 表示还没初始化，调用方要拿群状态里的 initiator 补群主。
   */
  get(threadId) {
    const file = this.#file(threadId)
    if (!existsSync(file)) return null
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (!raw || typeof raw !== 'object') return null
      return this.#normalize(raw)
    } catch {
      // 写坏了就当没初始化：至少还能按群主重建，不至于整群不可见
      return null
    }
  }

  save(threadId, data) {
    this.#ensureDir()
    const file = this.#file(threadId)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.#normalize(data), null, 2), 'utf8')
    renameSync(tmp, file)
  }

  #normalize(raw) {
    const members = {}
    for (const [userId, m] of Object.entries(raw.members ?? {})) {
      if (!m || typeof m !== 'object') continue
      const role = MEMBER_ROLES[m.role] ? m.role : MEMBER_ROLES.member
      members[userId] = {
        role,
        nickname: typeof m.nickname === 'string' ? m.nickname : '',
        joinedAt: Number.isFinite(m.joinedAt) ? m.joinedAt : Date.now(),
        isBot: m.isBot === true,
      }
    }
    return { ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : null, members }
  }

  /**
   * 初始化一份成员表；已经有就只补缺的机器人。
   *
   * 老群没有成员文件（这个功能上线前建的）时，用群状态里的 initiator 当群主，
   * 机器人补成管理员：宁可少一个人可见，也不要把老群变成人人可进。
   */
  ensure(threadId, { owner, bot = null } = {}) {
    let data = this.get(threadId)
    let dirty = false
    if (!data) {
      if (!owner?.userId) return null
      data = {
        ownerId: owner.userId,
        members: {
          [owner.userId]: {
            role: MEMBER_ROLES.owner,
            nickname: owner.nickname ?? '',
            joinedAt: owner.at ?? Date.now(),
            isBot: false,
          },
        },
      }
      dirty = true
    }
    if (bot?.id && !data.members[bot.id]) {
      data.members[bot.id] = {
        role: MEMBER_ROLES.admin,
        nickname: bot.nickname ?? '',
        joinedAt: Date.now(),
        isBot: true,
      }
      dirty = true
    }
    // 只在真变化时落盘：这个函数会在每次列群/看详情时被调用，
    // 无脑 save 等于每次刷新都重写一遍所有群的成员文件。
    if (dirty) this.save(threadId, data)
    return data
  }

  /** 加人，已在群里就保持原角色（重复扫码/重复加入不该把人降级） */
  add(threadId, user, role = MEMBER_ROLES.member) {
    if (!user?.id) return null
    const data = this.get(threadId)
    if (!data) return null
    if (data.members[user.id]) return data
    data.members[user.id] = {
      role: MEMBER_ROLES[role] ? role : MEMBER_ROLES.member,
      nickname: user.nickname ?? user.username ?? '',
      joinedAt: Date.now(),
      isBot: user.isBot === true || user.role === 'bot',
    }
    this.save(threadId, data)
    return data
  }

  setRole(threadId, userId, role) {
    if (!MEMBER_ROLES[role] || role === MEMBER_ROLES.owner) {
      return { ok: false, error: '角色只能是群管理员或普通成员' }
    }
    const data = this.get(threadId)
    if (!data?.members[userId]) return { ok: false, error: '这个人不在群里' }
    if (data.ownerId === userId) return { ok: false, error: '群主不能改自己的角色' }
    if (data.members[userId].isBot) return { ok: false, error: '机器人账号自动就是群管理员' }
    data.members[userId].role = role
    this.save(threadId, data)
    return { ok: true, data }
  }

  remove(threadId, userId) {
    const data = this.get(threadId)
    if (!data?.members[userId]) return { ok: false, error: '这个人不在群里' }
    if (data.ownerId === userId) return { ok: false, error: '群主不能退出群' }
    delete data.members[userId]
    this.save(threadId, data)
    return { ok: true, data }
  }

  roleOf(threadId, userId) {
    const data = this.get(threadId)
    return data?.members?.[userId]?.role ?? null
  }

  isMember(threadId, userId) {
    return Boolean(userId) && Boolean(this.get(threadId)?.members?.[userId])
  }

  /** 成员列表：群主 → 群管理员 → 普通成员，同角色按加入时间 */
  list(threadId) {
    const data = this.get(threadId)
    if (!data) return []
    return Object.entries(data.members)
      .map(([userId, m]) => ({
        userId,
        nickname: m.nickname,
        role: m.role,
        joinedAt: m.joinedAt,
        isBot: m.isBot,
      }))
      .sort((a, b) => {
        const ra = ROLE_RANK[a.role] ?? 9
        const rb = ROLE_RANK[b.role] ?? 9
        if (ra !== rb) return ra - rb
        return (a.joinedAt ?? 0) - (b.joinedAt ?? 0)
      })
  }

  count(threadId) {
    return this.list(threadId).length
  }
}
