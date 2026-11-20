/**
 * 消息投递。
 *
 * 编排层（flow-bridge.js）里 26 处 sendPlain 和 2 处发图/发文件，全都只认
 * 一个「会话标识」。以前那个标识是 QQ 群号，出口是 OneBot；现在唯一出口
 * 是这里，把消息写进 App 的消息库。
 *
 * 保留这一层的理由不是「以后还要接别的通道」，而是编排层不该知道
 * 消息怎么存（JSONL 追加、产物目录、URL 形状）。把它俩解耦之后，
 * flow-bridge 只管「说给谁听」，存储细节全在这里。
 */
import { readFileSync } from 'node:fs'

/**
 * @param {object} o
 * @param {import('../store/messages.js').MessageStore} o.messages
 * @param {import('../store/artifacts.js').ArtifactStore} o.artifacts
 * @param {(...a:any[])=>void} o.log
 */
export function createTransport({ messages, artifacts, log }) {
  /** 发纯文本。落库失败只记日志：一条播报丢了不该让整个回合崩掉。 */
  async function sendText(threadId, text, { replyTo = null } = {}) {
    const id = String(threadId)
    try {
      messages.append(id, { role: 'bot', kind: 'text', payload: { text } })
    } catch (err) {
      log(`[${id}] 消息落库失败：${err.message}`)
    }
  }

  /**
   * 发图片。
   *
   * 不拼 base64 直接入库：一张设计稿动辄几 MB，base64 还要再大 33%，
   * 而 App 是每次轮询按需拉取的。落成产物文件给 URL 更省。
   */
  async function sendImage(threadId, { buffer, name } = {}) {
    const id = String(threadId)
    const fileName = name || 'image.png'
    try {
      const rec = artifacts.put(id, { name: fileName, buffer })
      messages.append(id, {
        role: 'bot',
        kind: 'image',
        payload: { url: rec.url, name: rec.name },
      })
    } catch (err) {
      log(`[${id}] 图片保存失败：${err.message}`)
      // 存不下就退化成一条文本提示，至少告诉用户「有图但发不出来」
      try {
        messages.append(id, {
          role: 'bot',
          kind: 'text',
          payload: { text: `有张图没能保存：${err.message}` },
        })
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 发文件。
   *
   * 读取用 try 包住：产物文件可能被人工清理掉，那时不该让整个回合崩。
   */
  async function sendFile(threadId, filePath, name) {
    const id = String(threadId)
    try {
      const buffer = readFileSync(filePath)
      const rec = artifacts.put(id, { name: name || 'file', buffer })
      messages.append(id, {
        role: 'bot',
        kind: 'file',
        payload: { url: rec.url, name: rec.name, size: rec.size },
      })
    } catch (err) {
      log(`[${id}] 文件投递失败：${err.message}`)
      try {
        messages.append(id, {
          role: 'bot',
          kind: 'text',
          payload: { text: `产物 ${name} 发送失败：${err.message}` },
        })
      } catch {
        /* ignore */
      }
    }
  }

  /** 记一条结构化事件（阶段变化、待决策卡片），App 用它画卡片。 */
  function event(threadId, kind, payload) {
    const id = String(threadId)
    try {
      messages.append(id, { role: 'bot', kind, payload })
    } catch (err) {
      log(`[${id}] 事件落库失败：${err.message}`)
    }
  }

  return { sendText, sendImage, sendFile, event }
}
