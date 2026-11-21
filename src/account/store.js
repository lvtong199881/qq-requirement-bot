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

export const ROLES = { admin: 'admin', member: 'member', bot: 'bot' }

/** 角色中文名，给 UI 和提示文案用 */
export const ROLE_LABELS = { admin: '系统管理员', member: '普通成员', bot: '机器人' }

/**
 * 机器人账号的固定 id。
 *
 * 它和普通账号存在同一张表里——群里 @ 的是「某个用户」，不是一段文本，
 * 所以消息归属、@ 判定、发言人显示都走账号，不能在代码里另挂一个名字。
 * id 固定是为了重启/换机器之后历史消息里的 @ 仍然对得上同一个人。
 */
export const BOT_USER_ID = 'u_bot'

/** 机器人账号的用户名（不可登录，密码字段一直是空的） */
export const BOT_USERNAME = 'bot'

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
      // 用户表损坏时不能静默当成「没有账号」。备份坏文件保留现场，再按空表启动：
      // 空表会让预设账号被重新建出来（admin/123456 又回来了），这是有意的——
      // 坏表状态下系统得能起来；但备份文件还在，能人工抢救。
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

    // 没有任何可用管理员时才给 admin。正常情况下启动时建好的预设账号
    // 已经占了这个位置，所以新注册的一律是普通成员——要提权得由管理员改，
    // 不能靠「注册得早」白拿权限。
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
   * 预设管理员。
   *
   * 新装好的系统如果非要人先跑去 App 注册一次才能用，那第一件事就会卡住：
   * 门店/同事拿到地址却进不去。所以默认放一个 admin 账号。
   *
   * 只在**用户表完全空**时创建，不是「没有管理员就补」：
   * 后者会在你把人降级/删表之后又冒出个 admin/123456，等于留下一个后门。
   * 密码改了就不会再变——这里只负责「第一次」。
   *
   * @returns {{created:boolean, user:object|null}}
   */
  ensureBootstrap({ username = 'admin', password = '123456', nickname = '管理员' } = {}) {
    if (this.data.users.length > 0) return { created: false, user: null }
    const badName = checkUsername(username)
    const badPwd = checkPassword(password)
    if (badName || badPwd) {
      return { created: false, user: null, error: badName || badPwd }
    }
    const salt = newSalt()
    const user = {
      id: `u_${randomId()}`,
      username: String(username).trim(),
      nickname: String(nickname ?? '').trim() || '管理员',
      role: ROLES.admin,
      salt,
      passwordHash: hashPassword(String(password), salt),
      createdAt: Date.now(),
      disabled: false,
      // 标记出来，好在日志和 UI 上提示「这是初始密码，该换了」
      preset: true,
    }
    this.data.users.push(user)
    this.#save()
    return { created: true, user: publicUser(user) }
  }

  /**
   * 机器人账号。
   *
   * 它本质上就是一个用户：有 id、有昵称，消息挂在它名下，群里 @ 的是它的昵称。
   * 区别只有两条——role 是 bot（权限表里不给任何「替人拍板」的权力），
   * 以及没有密码（永远不会有人以它的身份登录）。
   *
   * 昵称随配置走：改了 config.bot.name，下次启动就同步过来，
   * 历史消息里的 nickname 不动（那是当时的事实）。
   *
   * @returns {{created:boolean, user:object}}
   */
  ensureBot({ nickname = 'AI员工' } = {}) {
    const name = String(nickname ?? '').trim() || 'AI员工'
    const existing = this.findById(BOT_USER_ID)
    if (existing) {
      if (existing.role !== ROLES.bot) existing.role = ROLES.bot
      if (existing.nickname !== name) {
        existing.nickname = name
        this.#save()
      }
      return { created: false, user: publicUser(existing) }
    }
    const user = {
      id: BOT_USER_ID,
      username: BOT_USERNAME,
      nickname: name,
      role: ROLES.bot,
      createdAt: Date.now(),
      disabled: false,
      isBot: true,
    }
    this.data.users.push(user)
    this.#save()
    return { created: true, user: publicUser(user) }
  }

  /** 机器人账号（没有就返回 null） */
  botUser() {
    return this.findById(BOT_USER_ID)
  }

  /**
   * 登录。用户名错和密码错返回同一句文案——
   * 分开说等于免费提供一个「这个用户名存在」的探测器。
   */
  login({ username, password }) {
    const user = this.findByUsername(username)
    if (!user) return { ok: false, error: '用户名或密码不对' }
    // 机器人账号没有密码，也不该有人用它的身份操作
    if (user.role === ROLES.bot) return { ok: false, error: '用户名或密码不对' }
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
    // 机器人是系统的一部分，不是某个人：改它的角色等于把 agent 变成能拍板的账号
    if (user.role === ROLES.bot || role === ROLES.bot) {
      return { ok: false, error: '机器人账号的角色不能改' }
    }
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
    // 停掉机器人等于整个系统不能 @ 了，这是配置错误不是账号管理
    if (user.role === ROLES.bot) return { ok: false, error: '机器人账号不能停用' }
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
    // 给机器人设密码等于开一个能替 agent 说话的后门
    if (user.role === ROLES.bot) return { ok: false, error: '机器人账号不能设密码' }
    const bad = checkPassword(password)
    if (bad) return { ok: false, error: bad }
    user.salt = newSalt()
    user.passwordHash = hashPassword(password, user.salt)
    // 密码一改，「这还是初始密码」就不再成立，登录页的提示要跟着消失。
    // 不清这个标记的话，App 会一直挂着「初始密码 123456」，
    // 而那个密码其实已经登不进去了——最糟的一类提示。
    delete user.preset
    this.#save()
    return { ok: true }
  }

  /**
   * 还没改过密码的预设管理员。
   *
   * App 首屏拿它决定要不要显示「初始账号 admin / 123456」。
   * 只报预设、还是管理员、没被停用的——被人改过密码或降级之后
   * 就不该再提示一个登不进去的号码。
   */
  pendingPresetAdmin() {
    const u = this.data.users.find((x) => x.preset && x.role === ROLES.admin && !x.disabled)
    return u ? { username: u.username } : null
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
    // 机器人账号：App 用它决定「这行不给改角色/停用/重置密码」，
    // 也用来在成员列表里标出「这是 agent 不是人」
    isBot: Boolean(u.isBot) || u.role === ROLES.bot,
    // 预设账号还是那串初始密码时，App 上提醒一次。改过密码这个标记就没意义了，
    // 但留着它不会泄露什么——它只说明「这个号是系统建的」。
    preset: Boolean(u.preset),
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
