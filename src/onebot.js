/**
 * OneBot 11 客户端：正向 WebSocket（bridge 连 NapCat）。
 *
 * 只实现本项目用得到的部分：收群消息事件、调用 send_group_msg /
 * upload_group_file。Node 22+ 自带 WebSocket，不需要任何依赖。
 */
import { EventEmitter } from 'node:events'

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
  }

  connect() {
    const url = this.token
      ? `${this.wsUrl}${this.wsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.token)}`
      : this.wsUrl

    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.connected = true
      this.emit('connected')
    })

    ws.addEventListener('message', (e) => this.#onFrame(e.data))

    ws.addEventListener('close', () => {
      this.connected = false
      this.emit('disconnected')
      this.#failAllPending('OneBot 连接已断开')
      if (!this.closed) {
        setTimeout(() => this.connect(), this.reconnectMs).unref?.()
      }
    })

    ws.addEventListener('error', () => {
      // close 事件会接手重连，这里只上报，避免重复调度
      this.emit('error', new Error('OneBot WebSocket 错误'))
    })
  }

  close() {
    this.closed = true
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

  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message })
  }

  /**
   * 发群文件。NapCat 支持 upload_group_file。
   * @param {string} groupId
   * @param {string} filePath 本机绝对路径
   * @param {string} name 群文件里显示的文件名
   */
  uploadGroupFile(groupId, filePath, name) {
    return this.call('upload_group_file', {
      group_id: Number(groupId),
      file: filePath,
      name,
    })
  }
}
