/**
 * 引擎通道：IM 作为服务端，需求引擎（dsh 编排）作为它的客户端。
 *
 * 为什么引擎连进来、而不是 IM 主动推给引擎：
 * 需求引擎要碰项目仓库、worktree、模拟器，通常跑在有代码和模型凭证的
 * 那台机器上；IM 可能部署在公网小机器上。让引擎往外连（到 IM），
 * IM 就不用知道引擎在哪、也不用手上存一堆内网地址；引擎换机器只要改配置。
 *
 * 协议刻意做成「长轮询 + 四个接口」，不用 WebSocket：
 *   - 断线重连就是下一次 GET，不用写退避重连状态机；
 *   - 所有请求都是普通 HTTP，过反向代理/Cloudflare 不用额外配置；
 *   - 事件落盘带游标，断多久都能补跑。
 *
 * 鉴权用固定的 engine token（config.api.engineToken）。它和用户 token 是
 * 两套东西：引擎不是某个用户，也不该拿用户的过期权来跑活。
 */
import { roleLabelOf } from '../account/store.js'
import { json, readBody } from './http-util.js'

/** 多久没轮询就算引擎离线。引擎每 25 秒一次长轮询，留出两倍余量 */
const OFFLINE_AFTER_MS = 70_000

/** 引擎回写消息时允许的 kind，和 transport.js 的四类对齐 */
const KINDS = new Set(['text', 'image', 'file', 'stage', 'decision'])

/**
 * @param {object} o
 * @param {import('../im/events.js').EngineEvents} o.events
 * @param {import('../store/messages.js').MessageStore} o.messages
 * @param {import('../store/artifacts.js').ArtifactStore} o.artifacts
 * @param {import('../state.js').SessionStore} o.groups  群元数据（name/mode/engine）
 * @param {import('../account/store.js').UserStore} o.users
 * @param {string} o.token  引擎共享密钥
 * @param {(...a:any[])=>void} o.log
 * @param {string} [o.botName]
 */
export function createEngineApi({ events, messages, artifacts, groups, users, token, log, botName = '需求bot' }) {
  let lastPollAt = 0

  // 从没连上过时返回 null（「不知道」），而不是 false（「掉线了」）：
  // 只想用 IM 聊天的部署永远不会配引擎，App 不该顶一条「引擎没连上」的横幅。
  const isOnline = () => (lastPollAt ? Date.now() - lastPollAt < OFFLINE_AFTER_MS : null)

  const authorized = (req) => {
    if (!token) return false
    const h = String(req.headers.authorization ?? '')
    const m = h.match(/^Bearer\s+(.+)$/i)
    return Boolean(m) && m[1].trim() === token
  }

  const deny = (res) =>
    json(res, 401, { ok: false, error: '引擎密钥不对', code: 'unauthorized' })

  /** 引擎回写的群状态：合并进群文件，别把 IM 自己维护的字段冲掉 */
  const applyGroup = (id, body) => {
    const st = groups.get(id)
    if (!st || Object.keys(st).length === 0) return null
    const prev = st.engine && typeof st.engine === 'object' ? st.engine : {}
    const next = { ...prev, at: Date.now() }
    // 白名单：引擎只能改「需求侧」的展示字段，群名、模式、成员都归 IM 管
    for (const k of ['reqId', 'reqName', 'stage', 'stageStatus', 'running', 'waitingLabel', 'featureBranch']) {
      if (body[k] !== undefined) next[k] = body[k]
    }
    const saved = { ...st, engine: next, lastActiveAt: Date.now() }
    groups.save(id, saved)
    return next
  }

  /**
   * @returns {Promise<boolean>} true 表示这条请求已经被引擎通道处理掉了
   */
  async function handle(req, res, { path, method, url }) {
    if (!path.startsWith('/api/engine/')) return false
    if (!token) {
      return json(res, 503, { ok: false, error: '引擎通道没启用（没配置 api.engineToken）' }), true
    }

    // 长轮询：引擎挂着这个 GET，用户一说话立刻收到
    if (method === 'GET' && path === '/api/engine/inbox') {
      if (!authorized(req)) return deny(res), true
      const after = Number(url.searchParams.get('after') ?? 0) || 0
      const wait = Math.min(30_000, Number(url.searchParams.get('wait') ?? 25_000) || 25_000)
      lastPollAt = Date.now()
      const list = await events.waitFor(after, wait)
      // 等完再看一眼时间：长轮询挂着的时候也算在线
      lastPollAt = Date.now()
      return json(res, 200, { ok: true, cursor: events.cursor, events: list }), true
    }

    if (method === 'GET' && path === '/api/engine/status') {
      // 这条不校验密钥：App 首屏要知道「引擎连没连上」，用户 token 就够
      return json(res, 200, { ok: true, online: isOnline(), botName, lastPollAt: lastPollAt || null }), true
    }

    if (!authorized(req)) return deny(res), true

    // 引擎发出来的消息：agent 的回话、图片、阶段变化卡片都走这条
    if (method === 'POST' && path === '/api/engine/messages') {
      const body = await readBody(req, { limit: 8_000_000 })
      const groupId = String(body.groupId ?? '').trim()
      const kind = String(body.kind ?? 'text')
      if (!groupId) return json(res, 400, { ok: false, error: '缺少 groupId' }), true
      if (!KINDS.has(kind)) return json(res, 400, { ok: false, error: `不认识的消息类型：${kind}` }), true
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {}
      if (kind === 'text' && !String(payload.text ?? '').trim()) {
        return json(res, 400, { ok: false, error: '消息不能为空' }), true
      }
      // 图片/文件：引擎把字节 base64 传过来，产物存在 IM 这边。
      // 为什么不给引擎一个上传地址：产物要跟着消息一起给 App 下载，
      // 存在 IM 的 .state/artifacts 下才有统一的鉴权和清理。
      let final = payload
      if ((kind === 'image' || kind === 'file') && typeof payload.data === 'string' && payload.data) {
        try {
          const buffer = Buffer.from(payload.data, 'base64')
          const hit = artifacts.put(groupId, { name: payload.name, buffer })
          final = { url: hit.url, name: hit.name, size: hit.size }
        } catch (err) {
          return json(res, 400, { ok: false, error: `产物没存下：${err.message}` }), true
        }
      }
      const msg = messages.append(groupId, { role: 'bot', kind, payload: final })
      const st = groups.get(groupId)
      if (st && Object.keys(st).length) groups.save(groupId, { ...st, lastActiveAt: Date.now() })
      return json(res, 200, { ok: true, seq: msg.seq }), true
    }

    // 引擎报群状态：列表页的阶段、进度、等待谁确认都靠它
    const groupMatch = path.match(/^\/api\/engine\/groups\/([^/]+)$/)
    if (method === 'POST' && groupMatch) {
      const groupId = decodeURIComponent(groupMatch[1])
      const body = await readBody(req)
      const engine = applyGroup(groupId, body)
      if (!engine) return json(res, 404, { ok: false, error: '没有这个群' }), true
      return json(res, 200, { ok: true, engine }), true
    }

    // 权限裁决留在 IM：用户表只有这边有。引擎每句话都问一次，别自己判
    if (method === 'GET' && path === '/api/engine/can') {
      const action = String(url.searchParams.get('action') ?? '').trim()
      const userId = String(url.searchParams.get('userId') ?? '').trim()
      const user = userId ? users.findById(userId) : null
      if (!action) return json(res, 400, { ok: false, error: '缺少 action' }), true
      if (!user) return json(res, 200, { ok: false, error: '没有这个用户' }), true
      if (user.disabled) return json(res, 200, { ok: false, error: '账号已停用' }), true
      const r = users.can(action, user)
      if (r.ok) return json(res, 200, { ok: true, role: user.role, roleLabel: roleLabelOf(user.role) }), true
      return json(res, 200, { ok: false, error: r.error, role: user.role, roleLabel: roleLabelOf(user.role) }), true
    }

    return json(res, 404, { ok: false, error: '未知接口' }), true
  }

  return {
    handle,
    status: () => ({ online: isOnline(), botName, lastPollAt: lastPollAt || null }),
  }
}
