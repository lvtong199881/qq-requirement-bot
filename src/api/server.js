/**
 * 公网 API：给 Flutter App 用的服务端。
 *
 * 和 src/ui/server.js 是两个东西，绝不能合并：
 *   ui/server.js  只听 127.0.0.1，管面板，能 stop/restart 群、改配置
 *   这里           听 0.0.0.0（或反向代理回环），只做「看需求 + 发消息 + 批决策」
 * 面板的 token 为空时直接放行，一旦被公网扫到等于把整台机器交出去。
 *
 * 认证用自己签的 HS256 token（见 account/auth.js），不引 jsonwebtoken。
 * 每个请求都要重新查用户表，不信 token 里带的角色——管理员降级后
 * 旧 token 必须立刻失效，否则「已经撤权但还能批需求」。
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { roleLabelOf } from '../account/store.js'
import { json, readBody } from './http-util.js'

/** 登录/注册的失败次数限制，防暴力破解。按 IP 计 */
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX_FAILS = 20

/**
 * @param {object} o
 * @param {import('../account/store.js').UserStore} o.users
 * @param {import('../store/messages.js').MessageStore} o.messages
 * @param {(threadId: string) => object|null} o.threadInfo  取某条需求的完整状态
 * @param {() => Promise<object>} o.listThreads  需求列表（大盘）
 * @param {(o: {threadId:string, text:string, user:object, mentions?:string[]}) => Promise<object>} o.deliver
 *        把一条用户消息投进群里。普通聊天就地留下，@ 了需求 bot 才交给引擎
 * @param {(o: {name?:string, user:object}) => Promise<object>} o.createGroup  新建群
 * @param {(o: {threadId:string, user:object}) => Promise<object>} o.joinGroup  加入群
 * @param {(o: {threadId:string, name:string, user:object}) => Promise<object>} o.renameGroup  改群名
 * @param {(o: {threadId:string, user:object}) => Promise<object>} o.membersOf  群成员列表
 * @param {(o: {threadId:string, userId:string, role:string, user:object}) => Promise<object>} o.setMemberRole
 * @param {(o: {threadId:string, user:object, seq:number}) => Promise<object>} o.markRead  记「读到哪儿了」，消红点
 * @param {import('../store/members.js').MemberStore} o.members  成员表：决定谁能看见哪个群
 * @param {{handle:Function, status:Function}=} o.engine  引擎通道（IM 独立部署时才有）
 * @param {string=} o.botName  agent 在群里的显示名，App 用它拼「@名字」，不在前端写死
 * @param {(...a:any[]) => void} o.log
 * @param {string=} o.allowedOrigin  CORS 白名单，空则允许所有（Flutter 原生不需要 CORS）
 */
export function createApiServer({
  users,
  messages,
  artifacts,
  threadInfo,
  listThreads,
  deliver,
  createGroup,
  joinGroup,
  renameGroup,
  membersOf,
  setMemberRole,
  markRead,
  members,
  engine = null,
  botName = 'AI员工',
  log,
  allowedOrigin = '',
}) {
  /** @type {Map<string, {fails:number, resetAt:number}>} */
  const rate = new Map()

  const clientIp = (req) =>
    // Cloudflare 会带 cf-connecting-ip，反代后 req.socket.remoteAddress 全是 127.0.0.1
    String(
      req.headers['cf-connecting-ip'] ??
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ??
        req.socket.remoteAddress ??
        'unknown',
    )

  /** 记录一次失败，返回 true 表示应该拒绝（已超限） */
  const hitRate = (ip, { fail = true } = {}) => {
    const now = Date.now()
    let rec = rate.get(ip)
    if (!rec || rec.resetAt < now) {
      rec = { fails: 0, resetAt: now + RATE_WINDOW_MS }
      rate.set(ip, rec)
    }
    if (fail) rec.fails++
    return rec.fails > RATE_MAX_FAILS
  }

  const clearRate = (ip) => rate.delete(ip)

  /**
   * 带群内角色的权限判定。
   *
   * canAct / 通过 / 打回都是「我在这个群里能不能拍板」，光看账号角色不够：
   * 群主和群管理员在自己群里也能拍板。群内角色在成员表里，所以这里
   * 先查一次 members.roleOf，再交给 users.can 两路合起来判。
   */
  const canIn = (threadId, action, user) => {
    let memberRole = null
    try {
      memberRole = threadId && members ? members.roleOf(threadId, user.id) : null
    } catch {
      // 成员文件读坏了不该让整个判定炸掉，退回只看账号角色
      memberRole = null
    }
    return users.can(action, user, memberRole)
  }

  /** 从 Authorization: Bearer xxx 里取 token */
  const bearer = (req) => {
    const h = String(req.headers.authorization ?? '')
    const m = h.match(/^Bearer\s+(.+)$/i)
    return m ? m[1].trim() : ''
  }

  /**
   * 取当前用户。返回 null 表示未登录。
   * 注意是每次查表，不是只看 token——见文件头注释。
   */
  const currentUser = (req) => {
    const token = bearer(req)
    if (!token) return null
    return users.authenticate(token)
  }

  /** 需要登录。未登录时已经把响应发出去了，返回 null 让调用方直接 return */
  const requireUser = (req, res) => {
    const user = currentUser(req)
    if (!user) {
      json(res, 401, { ok: false, error: '请先登录', code: 'unauthorized' })
      return null
    }
    return user
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'

    // CORS：Flutter Web 调试和浏览器里直接调接口时需要。
    // 不用 * 是因为带 Authorization 的请求遇上 * 会被浏览器拒掉。
    const origin = allowedOrigin || req.headers.origin || ''
    if (origin) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-headers', 'authorization,content-type')
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
      res.setHeader('access-control-max-age', '86400')
    }
    if (method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }

    try {
      // ── 引擎通道 ──
      // 走自己的 token，和用户登录是两套：引擎不是某个用户，
      // 也不该靠某个人的会过期 token 活着。放在登录校验之前是必须的，
      // 否则引擎的请求会先被这里 401 掉。
      if (engine && (await engine.handle(req, res, { path, method, url }))) return

      // ── 无需登录 ──

      if (method === 'GET' && path === '/healthz') {
        return json(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()) })
      }

      // 注册状态：App 首屏要判断「显示注册还是只显示登录」
      if (method === 'GET' && path === '/api/auth/status') {
        // 还有没改过密码的预设管理员时，把账号名带回去——
        // 这样首屏可以直接写「用 admin / 123456 登录」，
        // 用户不用去翻文档或猜。改过密码就不会再返回。
        const preset = users.pendingPresetAdmin()
        return json(res, 200, {
          ok: true,
          needsFirstAdmin: users.needsFirstAdmin(),
          presetAdmin: preset ? preset.username : null,
          // 预设密码是固定的，写在代码里也是公开的。
          // 只在这一刻跟着账号名一起给，改过就都不给了。
          presetPassword: preset ? '123456' : null,
        })
      }

      if (method === 'POST' && path === '/api/auth/register') {
        const ip = clientIp(req)
        if (hitRate(ip, { fail: false })) {
          return json(res, 429, { ok: false, error: '操作太频繁，过十分钟再试' })
        }
        const body = await readBody(req)
        const result = users.register({
          username: body.username,
          password: body.password,
          nickname: body.nickname,
        })
        if (!result.ok) {
          hitRate(ip)
          return json(res, 400, { ok: false, error: result.error })
        }
        clearRate(ip)
        log(`[api] 新账号：${result.user.username}（${result.user.roleLabel}）`)
        // 只有空表时注册才会直接当上管理员；有预设账号时这里就是日常注册
        return json(res, 200, {
          ok: true,
          token: result.token,
          user: result.user,
          notice: result.user.role === 'admin' ? '你是第一个注册的，已自动成为系统管理员' : '',
        })
      }

      if (method === 'POST' && path === '/api/auth/login') {
        const ip = clientIp(req)
        if (hitRate(ip, { fail: false })) {
          return json(res, 429, { ok: false, error: '尝试太多次，过十分钟再试' })
        }
        const body = await readBody(req)
        const result = users.login({ username: body.username, password: body.password })
        if (!result.ok) {
          hitRate(ip)
          return json(res, 401, { ok: false, error: result.error })
        }
        clearRate(ip)
        return json(res, 200, { ok: true, token: result.token, user: result.user })
      }

      // ── 以下都需要登录 ──

      if (method === 'GET' && path === '/api/auth/me') {
        const user = requireUser(req, res)
        if (!user) return
        // 顺手把「你能做什么」告诉前端，省得前端硬编码角色判断
        return json(res, 200, {
          ok: true,
          user: shapeUser(user, users),
          can: permissionsOf(user, users),
        })
      }

      if (method === 'GET' && path === '/api/threads') {
        const user = requireUser(req, res)
        if (!user) return
        const list = await listThreads({ userId: user.id })
        // unread 由 threads 服务算好（别人发的、我读到哪儿之后还剩多少），
        // 这里只补 lastSeq 与 canAct/canStart——列表页的增量游标要用最新的 seq。
        // canAct/canStart 是「我在这个群里」能不能拍板/提需求，所以带 threadId 判。
        const threads = list.map((t) => ({
          ...t,
          lastSeq: messages.lastSeq(t.threadId),
          canAct: canIn(t.threadId, 'confirm', user).ok,
          canStart: canIn(t.threadId, 'startRequirement', user).ok,
        }))
        // 引擎在不在线决定 App 要不要显示「需求暂时不可用」——
        // 这个状态放列表里，省得前端为一个布尔值再打一次接口。
        // botName 一起带上：App 要拼「@AI员工」，名字可配置就不能写死。
        return json(res, 200, {
          ok: true,
          threads,
          botName,
          engine: engine ? engine.status() : null,
        })
      }

      if (method === 'POST' && path === '/api/threads') {
        const user = requireUser(req, res)
        if (!user) return
        // 建群不限角色：群是私有的，建群的人就是这个群的群主，
        // 然后他能在自己群里提需求。以前这里要求系统管理员，
        // 结果普通成员连入口都没有，流程永远只能管理员一个人跑。
        const perm = users.can('createGroup', user)
        if (!perm.ok) {
          return json(res, 403, {
            ok: false,
            error: '建群需要管理员权限',
            code: 'forbidden',
            role: user.role,
            // 和 approve/reject 的 403 保持同一形状：前端只有一套错误解析
            roleLabel: roleLabelOf(user.role),
          })
        }
        const body = await readBody(req)
        // 建群只要一个名字。需求不在这一步提：群建好之后在群里说
        // 第一句话，那句话才是需求描述（见 flow-bridge 的 startNewRequirement）。
        const name = String(body.name ?? '').trim()
        if (name.length > 40) return json(res, 400, { ok: false, error: '群名太长了，40 字以内' })

        const result = await createGroup({ name, user })
        if (!result.ok) return json(res, 400, result)
        // 建完群就进详情，先把名字带上，省得第一屏闪烁一次默认名字。
        // canStart/canAct 一起算出来：建群的人刚成为群主，详情页要立刻
        // 让他能 @ 需求 bot、能拍板，等下一次轮询才亮按钮会闪一下。
        const tid = result.threadId ?? result.thread?.threadId
        return json(res, 200, {
          ...result,
          thread: result.thread
            ? {
                ...result.thread,
                botName,
                canAct: canIn(tid, 'confirm', user).ok,
                canStart: canIn(tid, 'startRequirement', user).ok,
              }
            : result.thread,
        })
      }

      // 产物下载。/api/threads/:id/artifacts/:token
      // 单独一条路由而不是塞进下面的 sub 匹配：token 是 a+16位hex，
      // 含数字，和 (\/[a-z]+)? 那种纯字母后缀的匹配规则不兼容。
      const artMatch = path.match(/^\/api\/threads\/([^/]+)\/artifacts\/([^/]+)$/)
      if (artMatch && method === 'GET') {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(artMatch[1])
        const token = decodeURIComponent(artMatch[2])
        const hit = artifacts.resolve(threadId, token)
        if (!hit) return json(res, 404, { ok: false, error: '文件不存在或已清理' })

        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': hit.size,
          // 文件名进 content-disposition 要做 ASCII 兜底 + RFC 5987 的 UTF-8 形式，
          // 否则中文名在部分客户端上会变成乱码或被截断
          'content-disposition': `attachment; filename="${asciiFallback(hit.name)}"; filename*=UTF-8''${encodeURIComponent(hit.name)}`,
          'cache-control': 'private, max-age=3600',
        })
        createReadStream(hit.path).pipe(res)
        return
      }

      // ── 群成员与入群 ──
      // 这几条单独放在详情路由之前：/preview 与 /join 不能被
      // 「必须先加入才能看」的逻辑挡住，否则永远加不进去。

      // 群号搜索：只看「存不存在、叫什么、几个人」，不给任何聊天内容
      const previewMatch = path.match(/^\/api\/threads\/([^/]+)\/preview$/)
      if (previewMatch && method === 'GET') {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(previewMatch[1])
        const info = await threadInfo(threadId, { userId: user.id })
        if (!info) return json(res, 404, { ok: false, error: '没有这个群' })
        return json(res, 200, {
          ok: true,
          preview: {
            threadId,
            groupName: info.groupName ?? null,
            memberCount: info.memberCount ?? 0,
            joined: Boolean(members?.isMember(threadId, user.id)),
            ownerNickname: members?.list(threadId).find((m) => m.role === 'owner')?.nickname ?? null,
          },
        })
      }

      const joinMatch = path.match(/^\/api\/threads\/([^/]+)\/join$/)
      if (joinMatch && method === 'POST') {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(joinMatch[1])
        const result = await joinGroup({ threadId, user })
        if (result?.notFound) return json(res, 404, { ok: false, error: '没有这个群' })
        if (result?.ok === false) return json(res, 400, { ok: false, error: result.error })
        return json(res, 200, {
          ok: true,
          joined: result.joined,
          thread: result.thread ? { ...result.thread, botName } : result.thread,
        })
      }

      // 已读到哪儿：App 拉到消息、或进详情页时上报一次，用来消列表红点
      const readMatch = path.match(/^\/api\/threads\/([^/]+)\/read$/)
      if (readMatch && method === 'POST') {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(readMatch[1])
        const body = await readBody(req)
        const result = await markRead({ threadId, user, seq: body.seq })
        if (result?.notFound) return json(res, 404, { ok: false, error: '没有这个群' })
        if (result?.forbidden) {
          return json(res, 403, { ok: false, error: result.error, code: 'not_member' })
        }
        return json(res, 200, result)
      }

      const membersMatch = path.match(/^\/api\/threads\/([^/]+)\/members$/)
      if (membersMatch && method === 'GET') {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(membersMatch[1])
        const result = await membersOf({ threadId, user })
        if (result?.notFound) return json(res, 404, { ok: false, error: '没有这个群' })
        if (result?.forbidden) {
          return json(res, 403, { ok: false, error: result.error, code: 'not_member' })
        }
        return json(res, 200, result)
      }

      const roleMatch = path.match(/^\/api\/threads\/([^/]+)\/members\/([^/]+)\/role$/)
      if (roleMatch && method === 'POST') {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(roleMatch[1])
        const targetId = decodeURIComponent(roleMatch[2])
        const body = await readBody(req)
        const result = await setMemberRole({ threadId, userId: targetId, role: body.role, user })
        if (result?.notFound) return json(res, 404, { ok: false, error: '没有这个群' })
        if (result?.forbidden) {
          return json(res, 403, { ok: false, error: result.error, code: 'forbidden' })
        }
        if (result?.ok === false) return json(res, 400, { ok: false, error: result.error })
        return json(res, 200, result)
      }

      // 改群名：群管理员或系统管理员。放在详情之前，避免被成员闸门拦掉自己的群
      const renameMatch = path.match(/^\/api\/threads\/([^/]+)$/)
      if (renameMatch && method === 'PATCH') {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(renameMatch[1])
        const body = await readBody(req)
        const result = await renameGroup({ threadId, name: body.name, user })
        if (result?.notFound) return json(res, 404, { ok: false, error: '没有这个群' })
        if (result?.forbidden) {
          return json(res, 403, { ok: false, error: result.error, code: 'forbidden' })
        }
        if (result?.ok === false) return json(res, 400, { ok: false, error: result.error })
        return json(res, 200, result)
      }

      // 单条需求详情 + 消息
      const threadMatch = path.match(/^\/api\/threads\/([^/]+)(\/[a-z]+)?$/)
      if (threadMatch) {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(threadMatch[1])
        const sub = threadMatch[2]

        const info = await threadInfo(threadId, { userId: user.id })
        if (!info) return json(res, 404, { ok: false, error: '没有这个需求' })

        // 群是私有的：没加入就看不到任何内容。preview / join 已经单独放行。
        if (members && !members.isMember(threadId, user.id)) {
          return json(res, 403, {
            ok: false,
            error: '你还没加入这个群',
            code: 'not_member',
          })
        }


        if (method === 'GET' && !sub) {
          return json(res, 200, {
            ok: true,
            // botName 跟着详情一起回：详情页的「@名字」和气泡作者名都要用
            // canAct/canStart 都按「我在这个群里」判：群主/群管理员能拍板、能提需求
            thread: {
              ...info,
              canAct: canIn(threadId, 'confirm', user).ok,
              canStart: canIn(threadId, 'startRequirement', user).ok,
              botName,
            },
            engine: engine ? engine.status() : null,
          })
        }

        if (method === 'GET' && sub === '/messages') {
          const since = Number(url.searchParams.get('since') ?? 0) || 0
          const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 200) || 200)
          const page = messages.list(threadId, { since, limit })
          return json(res, 200, {
            ok: true,
            messages: page.messages,
            lastSeq: page.lastSeq,
          })
        }

        if (method === 'POST' && sub === '/messages') {
          const body = await readBody(req)
          const text = String(body.text ?? '').trim()
          if (!text) return json(res, 400, { ok: false, error: '消息不能为空' })
          if (text.length > 5000) return json(res, 400, { ok: false, error: '消息太长了' })
          const mentions = Array.isArray(body.mentions) ? body.mentions.map(String).slice(0, 20) : []
          // 提问卡片的提交：带结构化选择回来。有这个字段就说明不是在聊天，
          // 是用户点了卡片上的选项，deliver 据此不再要求 @ 一次。
          const answers = Array.isArray(body.answers) ? body.answers : null
          const askSeq = Number.isFinite(body.askSeq) ? body.askSeq : null

          // 落库、权限、分发都在 deliver 里：它才知道这个群是聊天还是需求群
          // （@ 了 bot 才开需求，权限要求和管理员建群一致）。
          // 被拒的话那句不落库——群里不该多一条自己说、agent 永远不会回的话。
          const result = await deliver({ threadId, text, user, mentions, answers, askSeq })
          if (result?.forbidden) {
            return json(res, 403, {
              ok: false,
              error: result.error,
              code: 'forbidden',
              role: user.role,
              // 和 approve/reject 的 403 保持同一形状：前端只有一套错误解析
              roleLabel: result.roleLabel ?? roleLabelOf(user.role),
            })
          }
          if (result?.notFound) return json(res, 404, { ok: false, error: result.error })
          if (result?.ok === false) return json(res, 400, { ok: false, error: result.error })
          return json(res, 200, { ok: true, ...result })
        }

        // 通过 / 打回：普通成员能看到按钮，但点了会被拒并给出原因
        const actionMatch = sub?.match(/^\/(approve|reject)$/)
        if (method === 'POST' && actionMatch) {
          const action = actionMatch[1]
          // 群主/群管理员在自己群里也能拍板，所以带 threadId 判
          const perm = canIn(threadId, 'confirm', user)
          if (!perm.ok) {
            return json(res, 403, {
              ok: false,
              error: '通过和打回只有管理员能操作',
              code: 'forbidden',
              role: user.role,
              roleLabel: roleLabelOf(user.role),
            })
          }
          const body = await readBody(req)
          // 打回的意见是必填的：只说「不行」agent 没法改
          const reason = String(body.reason ?? '').trim()
          if (action === 'reject' && !reason) {
            return json(res, 400, { ok: false, error: '打回要写一句意见，不然不知道该怎么改' })
          }

          // 通过/打回最终就是一句自然语言，交给编排层理解。
          // 不另造协议：agent 本来就按对话工作，多一层结构化指令反而要维护两套语义。
          // 落库在 deliver 里统一做，这里不再自己 append（否则会存两条一模一样的）。
          // force：按钮不是打字，不要求用户再去 @ 一次；权限上面刚判过 confirm。
          const text = action === 'approve' ? '通过' : `打回：${reason}`
          const result = await deliver({ threadId, text, user, force: true })
          if (result?.notFound) return json(res, 404, { ok: false, error: result.error })
          return json(res, 200, { ok: true, ...result })
        }

        return json(res, 404, { ok: false, error: '未知接口' })
      }

      // ── 账号管理，仅管理员 ──
      if (path.startsWith('/api/users')) {
        const user = requireUser(req, res)
        if (!user) return
        if (user.role !== 'admin') {
          return json(res, 403, { ok: false, error: '只有系统管理员能管理账号', code: 'forbidden' })
        }

        if (method === 'GET' && path === '/api/users') {
          return json(res, 200, { ok: true, users: users.list() })
        }

        const um = path.match(/^\/api\/users\/([^/]+)\/(role|disabled|password)$/)
        if (method === 'POST' && um) {
          const id = decodeURIComponent(um[1])
          const field = um[2]
          const body = await readBody(req)
          let result
          if (field === 'role') result = users.setRole(id, body.role)
          else if (field === 'disabled') result = users.setDisabled(id, body.disabled)
          else result = users.resetPassword(id, body.password)

          if (!result.ok) return json(res, 400, result)
          log(`[api] ${user.username} 修改了账号 ${id} 的 ${field}`)
          return json(res, 200, result)
        }
        return json(res, 404, { ok: false, error: '未知接口' })
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      log(`[api] ${method} ${path} 失败：${err.message}`)
      // 不把内部错误原文返回给公网调用方：栈信息会泄露目录结构
      return json(res, 500, { ok: false, error: '服务器内部错误' })
    }
  })
}

/** 对外用户信息：去掉 salt / passwordHash */
function shapeUser(user, users) {
  const pub = users.list().find((u) => u.id === user.id)
  return pub ?? { id: user.id, username: user.username, role: user.role }
}

/**
 * content-disposition 里的 ASCII 兜底名。
 * 非 ASCII 字符会被规范禁止，直接塞中文在部分客户端上整个头会失效，
 * 所以把非 ASCII 换成下划线，真正的名字交给 filename* 那一份。
 */
function asciiFallback(name) {
  const s = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return s || 'file'
}

/**
 * 当前用户能做什么。前端拿到这个决定「按钮要不要置灰」，
 * 而不是自己硬编码 if (role === 'admin')——规则变了只改服务端一处。
 *
 * 注意这里没有 threadId，所以只能回答「账号层面」的权限：
 * startRequirement / confirm 在这里对普通成员是 false，但他在自己建的群里
 * 是群主，实际能提需求、能拍板。群内那一路要看 thread.canStart / canAct
 * （详情和列表接口都会带上），别拿这里的值去锁群里的按钮。
 */
function permissionsOf(user, users) {
  const actions = ['createGroup', 'startRequirement', 'confirm', 'command', 'comment', 'read']
  const out = {}
  for (const a of actions) out[a] = users.can(a, user).ok
  return out
}
