/**
 * 用户表：注册、登录、角色。
 *
 * 落盘到 .state/users.json，和状态机文件同目录，一起被 .gitignore 挡住。
 * 整表读进内存再全量原子写——团队内部几十个账号的量级，
 * 按行追加再处理 partial write 反而更容易错。
 *
 * 角色模型（替代原来的 QQ 群主/群管理员）：
 *   admin   系统管理员，建需求、通过、打回、管账号
 *   member  普通成员，能看一切，能补充说明，但点「通过/打回」会被拒
 *
 * 为什么不是「群主」：App 里没有群。发起需求的人自然成为该需求的 owner，
 * 这个身份挂在 flow 状态上，不挂在用户表上。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkPassword,
  checkUsername,
  hashPassword,
  newSalt,
  newSecret,
  signToken,
  verifyPassword,
  verifyToken,
} from './auth.js'

export const ROLES = { admin: 'admin', member: 'member' }

/** 角色中文名，给 UI 和提示文案用 */
export const ROLE_LABELS = { admin: '系统管理员', member: '普通成员' }

export class UserStore {
  /**
   * @param {string} dir 落盘目录，通常是 join(repoRoot, '.state')
   */
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'users.json')
    this.secretFile = join(dir, 'session.key')
    /** @type {{users: object[], secret: string}} */
    this.data = { users: [], secret: '' }
    this.#load()
  }

  #ensureDir() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    } catch {
      /* 真建不了就让后续写入报错 */
    }
  }

  #load() {
    this.#ensureDir()

    // 签名密钥单独存：换密钥 = 所有人掉登录，这是「踢掉所有人」的应急开关。
    // 但它不属于用户表，混在一起会在导出用户列表时连带泄露。
    let secret = ''
    try {
      if (existsSync(this.secretFile)) secret = readFileSync(this.secretFile, 'utf8').trim()
    } catch {
      /* 读不到就当没有，下面重新生成 */
    }
    if (!secret) {
      secret = newSecret()
      this.#writeAtomic(this.secretFile, secret)
    }

    let users = []
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        if (Array.isArray(raw?.users)) users = raw.users
      }
    } catch {
      // 用户表损坏时不能静默当成「没有账号」——那会让下一个人注册拿到 admin。
      // 备份一份坏文件保留现场，然后按空表启动（此时第一个注册者仍是 admin，
      // 但至少坏文件还在，能人工抢救）。
      try {
        if (existsSync(this.file)) {
          renameSync(this.file, `${this.file}.broken-${Date.now()}`)
        }
      } catch {
        /* ignore */
      }
    }
    this.data = { users, secret }
  }

  #writeAtomic(file, content) {
    this.#ensureDir()
    const tmp = `${file}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, file)
  }

  #save() {
    this.#writeAtomic(this.file, JSON.stringify({ users: this.data.users }, null, 2))
  }

  /** 是否还没有任何管理员——决定第一个注册者能不能拿到 admin */
  needsFirstAdmin() {
    return !this.data.users.some((u) => u.role === ROLES.admin && !u.disabled)
  }

  findByUsername(username) {
    const key = String(username ?? '').trim().toLowerCase()
    return this.data.users.find((u) => u.username.toLowerCase() === key) ?? null
  }

  findById(id) {
    return this.data.users.find((u) => u.id === id) ?? null
  }

  /**
   * 注册。
   * @returns {{ok:true, user:object, token:string}|{ok:false, error:string}}
   */
  register({ username, password, nickname }) {
    const badName = checkUsername(username)
    if (badName) return { ok: false, error: badName }
    const badPwd = checkPassword(password)
    if (badPwd) return { ok: false, error: badPwd }

    const name = String(username).trim()
    if (this.findByUsername(name)) return { ok: false, error: '这个用户名已经有人用了' }

    // 第一个注册者自动成为管理员：否则新装好的系统没人能批需求，
    // 还得手动改 JSON，等于把初始化步骤推给用户。
    const role = this.needsFirstAdmin() ? ROLES.admin : ROLES.member
    const salt = newSalt()
    const user = {
      id: `u_${randomId()}`,
      username: name,
      nickname: String(nickname ?? '').trim() || name,
      role,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: Date.now(),
      disabled: false,
    }
    this.data.users.push(user)
    this.#save()
    return { ok: true, user: publicUser(user), token: this.issueToken(user) }
  }

  /**
   * 登录。用户名错和密码错返回同一句文案——
   * 分开说等于免费提供一个「这个用户名存在」的探测器。
   */
  login({ username, password }) {
    const user = this.findByUsername(username)
    if (!user) return { ok: false, error: '用户名或密码不对' }
    if (!verifyPassword(password, user.salt, user.passwordHash)) {
      return { ok: false, error: '用户名或密码不对' }
    }
    if (user.disabled) return { ok: false, error: '这个账号已被停用，找管理员处理' }

    user.lastLoginAt = Date.now()
    this.#save()
    return { ok: true, user: publicUser(user), token: this.issueToken(user) }
  }

  issueToken(user) {
    return signToken({ sub: user.id, role: user.role }, this.data.secret)
  }

  /** 验 token 并取回最新用户（角色可能被管理员改过，不信 token 里的旧角色） */
  authenticate(token) {
    const payload = verifyToken(token, this.data.secret)
    if (!payload?.sub) return null
    const user = this.findById(payload.sub)
    if (!user || user.disabled) return null
    return user
  }

  /**
   * 权限判定，形状对齐原来 src/index.js 的 can(action, groupId, userId)。
   *
   * 为什么要对齐：flow-bridge 里 26 处调用全是 `can('confirm', uid)` 这种形式，
   * 返回 {ok, role}。保持签名不变，编排层一行都不用改。
   *
   * 动作 → 允许的角色：
   *   startRequirement  发起新需求        admin
   *   confirm           通过 / 打回       admin
   *   command           斜杠指令          admin
   *   release           交付              admin
   *   read              看板/消息         全体成员
   *   comment           补充说明          admin + member（成员能说话，但不能拍板）
   */
  can(action, user) {
    const need = ACTION_ROLES[action] ?? []
    if (!user || user.disabled) return { ok: false, role: null, need }
    if (need.length === 0) return { ok: true, role: user.role }
    if (need.includes(user.role)) return { ok: true, role: user.role }
    return { ok: false, role: user.role, need }
  }

  /** 账号管理：改角色 / 停用 / 重置密码，只有 admin 能调 */
  setRole(id, role) {
    const user = this.findById(id)
    if (!user) return { ok: false, error: '没有这个账号' }
    if (!ROLES[role]) return { ok: false, error: '角色只能是 admin 或 member' }
    // 不允许把最后一个管理员降级：否则没人能再管理，只能改 JSON 救场
    if (user.role === ROLES.admin && role !== ROLES.admin) {
      const others = this.data.users.filter(
        (u) => u.id !== id && u.role === ROLES.admin && !u.disabled,
      )
      if (others.length === 0) return { ok: false, error: '这是最后一个管理员，不能降级' }
    }
    user.role = role
    this.#save()
    return { ok: true, user: publicUser(user) }
  }

  setDisabled(id, disabled) {
    const user = this.findById(id)
    if (!user) return { ok: false, error: '没有这个账号' }
    if (disabled && user.role === ROLES.admin) {
      const others = this.data.users.filter((u) => u.id !== id && u.role === ROLES.admin && !u.disabled)
      if (others.length === 0) return { ok: false, error: '这是最后一个管理员，不能停用' }
    }
    user.disabled = Boolean(disabled)
    this.#save()
    return { ok: true, user: publicUser(user) }
  }

  resetPassword(id, password) {
    const user = this.findById(id)
    if (!user) return { ok: false, error: '没有这个账号' }
    const bad = checkPassword(password)
    if (bad) return { ok: false, error: bad }
    user.salt = newSalt()
    user.passwordHash = hashPassword(password, user.salt)
    this.#save()
    return { ok: true }
  }

  list() {
    return this.data.users.map(publicUser)
  }
}

/**
 * 动作 → 允许的角色。
 * 和 src/index.js 原来的 ACTION_ROLES 一一对应，只是把群主/群管理
 * 换成了 admin/member 两档——App 里没有群，只有需求。
 */
export const ACTION_ROLES = {
  startRequirement: [ROLES.admin],
  confirm: [ROLES.admin],
  command: [ROLES.admin],
  release: [ROLES.admin],
  read: [],
  comment: [],
}

/** 对外暴露的用户字段：绝不能带 salt 和 passwordHash */
export function publicUser(u) {
  if (!u) return null
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role] ?? u.role,
    createdAt: u.createdAt ?? null,
    lastLoginAt: u.lastLoginAt ?? null,
    disabled: Boolean(u.disabled),
  }
}

/**
 * 角色名。
 *
 * 单独导出是因为 authenticate() 返回的是**内部**用户对象（要拿 passwordHash
 * 之外的真实数据），没有 roleLabel 字段。服务端要在 403 响应里解释
 * 「你是普通成员所以我不能让你批」时，必须走这个函数取名字——
 * 直接读 user.roleLabel 会拿到 undefined，前端就只能显示「undefined」。
 */
export function roleLabelOf(role) {
  return ROLE_LABELS[role] ?? role
}

function randomId() {
  return newSecret().slice(0, 16)
}
