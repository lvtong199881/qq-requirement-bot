/**
 * OneBot 11 客户端：正向 WebSocket（bridge 连 NapCat）。
 *
 * 只实现本项目用得到的部分：收群消息事件、调用 send_group_msg /
 * upload_group_file。Node 22+ 自带 WebSocket，不需要任何依赖。
 */
import { EventEmitter } from 'node:events'
import { connect as netConnect } from 'node:net'
import { readFileSync } from 'node:fs'

/**
 * 探一下目标端口通不通，用来给失败原因下结论。
 * Node 的 WebSocket 在连接失败时 error 事件几乎不给信息，只能靠 TCP 层判断。
 * @returns {Promise<'open'|'refused'|'timeout'|'unreachable'|'unknown'>}
 */
function probeTcp(wsUrl, timeoutMs = 2000) {
  let host
  let port
  try {
    const u = new URL(wsUrl)
    host = u.hostname
    port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80))
  } catch {
    return Promise.resolve('unknown')
  }

  return new Promise((resolve) => {
    const sock = netConnect({ host, port })
    const timer = setTimeout(() => {
      sock.destroy()
      resolve('timeout')
    }, timeoutMs)

    sock.on('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve('open')
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      if (err.code === 'ECONNREFUSED') return resolve('refused')
      if (err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') return resolve('unreachable')
      resolve('unknown')
    })
  })
}

/** 把探测结果翻译成人能读的排查建议 */
export function explainProbe(result, wsUrl) {
  switch (result) {
    case 'refused':
      return `端口没有服务在监听 —— ${wsUrl} 上是空的。NapCat 没启动，或没开「WebSocket 服务端」。`
    case 'open':
      return `端口能连上，但 WebSocket 握手失败 —— 地址写错了（是不是该用 /onebot/v11/ws 之类的路径？），或 token 不对。`
    case 'timeout':
      return `连接超时 —— 端口被防火墙挡了，或地址不是本机。`
    case 'unreachable':
      return `解析不到主机 —— 检查 ${wsUrl} 里的主机名/IP。`
    default:
      return `无法判断原因，检查 ${wsUrl} 是否写对。`
  }
}

export class OneBot extends EventEmitter {
  /**
   * @param {{ws: string, token?: string, reconnectMs?: number}} opts
   */
  constructor(opts) {
    super()
    this.wsUrl = opts.ws
    this.token = opts.token || ''
    this.reconnectMs = opts.reconnectMs ?? 3000
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.connected = false
    this.selfId = null
    this.closed = false
    this.failures = 0
    this.lastError = null
    this.reconnectTimer = null
    this.keepAlive = null
  }

  connect() {
    this.#startKeepAlive()

    const url = this.token
      ? `${this.wsUrl}${this.wsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.token)}`
      : this.wsUrl

    let ws
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.failures++
      this.emit('connection-error', {
        failures: this.failures,
        probe: 'unknown',
        reason: `WebSocket 地址非法：${err.message}`,
      })
      this.#scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.connected = true
      this.failures = 0
      this.lastError = null
      this.emit('connected')
    })

    ws.addEventListener('message', (e) => this.#onFrame(e.data))

    ws.addEventListener('close', () => {
      this.connected = false
      this.emit('disconnected')
      this.#failAllPending('OneBot 连接已断开')
      this.#scheduleReconnect()
    })

    // 注意：不能 emit('error')——EventEmitter 对 'error' 有特殊语义，
    // 没有监听器时会把异常抛出去杀进程。用自定义事件名。
    ws.addEventListener('error', () => {
      this.failures++
      // WebSocket 的 error 事件几乎没有可用信息，改由 TCP 探测给出原因
      this.emit('connection-error', { failures: this.failures, probing: true })
      probeTcp(this.wsUrl).then((result) => {
        this.emit('connection-error', {
          failures: this.failures,
          probe: result,
          reason: explainProbe(result, this.wsUrl),
        })
      })
    })
  }

  #scheduleReconnect() {
    if (this.closed) return
    // 退化式退避：前 3 次快速重试，之后拉长到 30 秒，避免刷屏
    const delay =
      this.failures <= 3 ? this.reconnectMs : Math.min(this.reconnectMs * 2 ** Math.min(this.failures - 2, 4), 30000)

    // 绝不能 unref：这个定时器是「保持进程活着等 NapCat」的唯一理由。
    // unref 后一断开事件循环就空，进程会静默退出。
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** 有一个常驻定时器，保证即使没连上也别让进程空转退出 */
  #startKeepAlive() {
    if (this.keepAlive) return
    this.keepAlive = setInterval(() => {}, 60_000)
  }

  close() {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.keepAlive) {
      clearInterval(this.keepAlive)
      this.keepAlive = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }

  #onFrame(raw) {
    let frame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      return
    }

    // API 响应：有 echo 且带 status
    if (frame.echo && this.pending.has(frame.echo)) {
      const { resolve, reject, timer } = this.pending.get(frame.echo)
      clearTimeout(timer)
      this.pending.delete(frame.echo)
      if (frame.status === 'ok' || frame.retcode === 0) resolve(frame.data)
      else reject(new Error(`OneBot API 失败：${frame.message || frame.wording || frame.retcode}`))
      return
    }

    if (frame.post_type === 'meta_event' && frame.meta_event_type === 'lifecycle') {
      this.selfId = frame.self_id ?? this.selfId
      return
    }

    if (frame.post_type === 'message' || frame.post_type === 'message_sent') {
      this.selfId = frame.self_id ?? this.selfId
      // message_sent 是本账号自己发的，不能回环触发，但要用它纠正自号
      if (frame.post_type === 'message') this.emit('message', frame)
    }
  }

  #failAllPending(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  /** 调 OneBot API，带超时 */
  call(action, params = {}, timeoutMs = 15000) {
    if (!this.connected) return Promise.reject(new Error('OneBot 未连接'))
    const echo = `qqrs-${++this.seq}`
    const payload = JSON.stringify({ action, params, echo })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot API 超时：${action}`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(err)
      }
    })
  }

  /**
   * 查群成员角色：owner / admin / member。
   * 群管判定用它——比维护一份 QQ 白名单更贴近「谁在这个群里有权限」。
   */
  async getMemberRole(groupId, userId) {
    try {
      const info = await this.call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId),
        no_cache: false,
      })
      return info?.role ?? 'member'
    } catch {
      return null // 查不到就当没权限，交给调用方兜底
    }
  }

  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message })
  }

  /**
   * 发群文件。
   *
   * 关键：NapCat 可能跑在 Docker 里，看不到宿主机的文件路径，
   * 所以这里读文件内容走 base64:// 内联上传，不传绝对路径。
   * @param {string} groupId
   * @param {string} filePath 本机绝对路径（由 bridge 读取）
   * @param {string} name 群文件里显示的文件名
   */
  async uploadGroupFile(groupId, filePath, name) {
    const buf = readFileSync(filePath)
    return this.call(
      'upload_group_file',
      {
        group_id: Number(groupId),
        file: `base64://${buf.toString('base64')}`,
        name,
      },
      30000,
    )
  }
}
