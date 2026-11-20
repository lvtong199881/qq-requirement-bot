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

/** 登录/注册的失败次数限制，防暴力破解。按 IP 计 */
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX_FAILS = 20

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req, { limit = 1_000_000 } = {}) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    // 不设上限的 body 读取就是内存耗尽攻击的入口
    if (size > limit) throw new Error('请求体过大')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * @param {object} o
 * @param {import('../account/store.js').UserStore} o.users
 * @param {import('../store/messages.js').MessageStore} o.messages
 * @param {(threadId: string) => object|null} o.threadInfo  取某条需求的完整状态
 * @param {() => Promise<object>} o.listThreads  需求列表（大盘）
 * @param {(o: {threadId:string, text:string, user:object}) => Promise<object>} o.deliver
 *        把一条用户消息投进编排层。QQ 和 App 走同一个入口，行为完全一致
 * @param {(threadId: string) => Promise<object>} o.createThread  新建需求
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
  createThread,
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
        const list = await listThreads()
        // 未读数：每个 thread 最后一条 seq 减去用户读到的位置。
        // 现在没有「已读位置」存储，先用消息总数当提示，够用且不用新表。
        const threads = list.map((t) => ({
          ...t,
          lastSeq: messages.lastSeq(t.threadId),
          canAct: users.can('confirm', user).ok,
        }))
        return json(res, 200, { ok: true, threads })
      }

      if (method === 'POST' && path === '/api/threads') {
        const user = requireUser(req, res)
        if (!user) return
        const perm = users.can('startRequirement', user)
        if (!perm.ok) {
          return json(res, 403, {
            ok: false,
            error: '发起需求需要系统管理员权限',
            code: 'forbidden',
            role: user.role,
            // 和 approve/reject 的 403 保持同一形状：前端只有一套错误解析
            roleLabel: roleLabelOf(user.role),
          })
        }
        const body = await readBody(req)
        const text = String(body.text ?? '').trim()
        if (!text) return json(res, 400, { ok: false, error: '说点什么吧' })
        if (text.length > 5000) return json(res, 400, { ok: false, error: '需求描述太长了' })

        const result = await createThread({ text, user })
        if (!result.ok) return json(res, 400, result)
        return json(res, 200, result)
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

      // 单条需求详情 + 消息
      const threadMatch = path.match(/^\/api\/threads\/([^/]+)(\/[a-z]+)?$/)
      if (threadMatch) {
        const user = requireUser(req, res)
        if (!user) return
        const threadId = decodeURIComponent(threadMatch[1])
        const sub = threadMatch[2]

        const info = await threadInfo(threadId)
        if (!info) return json(res, 404, { ok: false, error: '没有这个需求' })

        if (method === 'GET' && !sub) {
          return json(res, 200, {
            ok: true,
            thread: { ...info, canAct: users.can('confirm', user).ok },
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

          // 落库用户这条：App 刷新后要能看见自己说过什么
          messages.append(threadId, {
            role: 'user',
            kind: 'text',
            payload: { text },
            at: Date.now(),
          })
          const result = await deliver({ threadId, text, user })
          return json(res, 200, { ok: true, ...result })
        }

        // 通过 / 打回：普通成员能看到按钮，但点了会被拒并给出原因
        const actionMatch = sub?.match(/^\/(approve|reject)$/)
        if (method === 'POST' && actionMatch) {
          const action = actionMatch[1]
          const perm = users.can('confirm', user)
          if (!perm.ok) {
            return json(res, 403, {
              ok: false,
              error: '通过和打回只有系统管理员能操作',
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
          const text = action === 'approve' ? '通过' : `打回：${reason}`
          messages.append(threadId, {
            role: 'user',
            kind: 'text',
            payload: { text },
            at: Date.now(),
          })
          const result = await deliver({ threadId, text, user })
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
 */
function permissionsOf(user, users) {
  const actions = ['startRequirement', 'confirm', 'command', 'comment', 'read']
  const out = {}
  for (const a of actions) out[a] = users.can(a, user).ok
  return out
}
