/**
 * 远端 transport：把 agent 要说的话发给另一台机器上的 IM。
 *
 * 和 transport.js 的接口完全一致（sendText / sendImage / sendFile / event），
 * 所以 flow-bridge 一行都不用改：单机时注入本地的那个，拆分时注入这个。
 * 这是整个拆分里最关键的一处接缝——编排层只管「说话」，怎么送达不归它管。
 *
 * 图片/文件走 base64 内联：引擎那台机器上的文件，IM 那台读不到。
 * 给引擎开一个上传接口再让 IM 去拉，等于把两台机器互相暴露成对方的文件服务，
 * 而消息本来就要传一次，内联反而是最少的一步。
 */
import { readFileSync, statSync } from 'node:fs'

/** 单个产物上限：base64 会涨 4/3，超过就别硬传了，退化成一句说明 */
const MAX_INLINE_BYTES = 20 * 1024 * 1024

/**
 * @param {object} o
 * @param {string} o.url  IM 的地址，如 https://im.example.com
 * @param {string} o.token 引擎密钥
 * @param {(msg:string)=>void} [o.log]
 * @param {number} [o.timeoutMs]
 */
export function createHttpTransport({ url, token, log = () => {}, timeoutMs = 30_000 }) {
  const base = String(url ?? '').replace(/\/+$/, '')

  const post = async (body) => {
    if (!base) throw new Error('没有配置 IM 地址（bot.config.json 的 im.url）')
    const res = await fetch(`${base}/api/engine/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data = {}
    try {
      data = JSON.parse(text)
    } catch {
      /* 反代返回的 HTML 错误页也会走到这里 */
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `IM 返回 ${res.status}`)
    }
    return data
  }

  /**
   * 统一兜住异常。
   *
   * 发不出去时不能把异常抛回 flow-bridge：那会把本来还在跑的需求回合打断，
   * 而 agent 其实已经干完了活。IM 那边的消息只是「送达」问题，转成日志。
   */
  const safe = async (label, body) => {
    try {
      return await post(body)
    } catch (err) {
      log(`[transport] ${label} 发送失败：${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  return {
    sendText(threadId, text, { replyTo = null } = {}) {
      return safe('文本', { groupId: threadId, kind: 'text', payload: { text }, replyTo })
    },

    sendImage(threadId, { buffer, name } = {}) {
      if (!buffer || !buffer.length) return Promise.resolve({ ok: false, error: '空图片' })
      if (buffer.length > MAX_INLINE_BYTES) {
        return this.sendText(threadId, `（图片 ${name ?? ''} 太大，没能发出来）`)
      }
      return safe('图片', {
        groupId: threadId,
        kind: 'image',
        payload: { name, data: buffer.toString('base64') },
      })
    },

    sendFile(threadId, filePath, name) {
      let buffer
      try {
        const size = statSync(filePath).size
        if (size > MAX_INLINE_BYTES) {
          return this.sendText(threadId, `（文件 ${name ?? ''} 太大，没能发出来）`)
        }
        buffer = readFileSync(filePath)
      } catch (err) {
        return this.sendText(threadId, `（文件 ${name ?? ''} 读取失败：${err.message}）`)
      }
      return safe('文件', {
        groupId: threadId,
        kind: 'file',
        payload: { name, data: buffer.toString('base64') },
      })
    },

    /** 阶段变化 / 待决策卡片这类结构化消息 */
    event(threadId, kind, payload = {}) {
      return safe(kind, { groupId: threadId, kind, payload })
    },
  }
}
