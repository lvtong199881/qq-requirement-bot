/**
 * 会话标识的分流通道。
 *
 * 这是整个 App 化改造里最关键的 20 行：编排层（flow-bridge.js）里
 * 26 处 sendPlain 和 2 处直接发图/发文件，全都只认一个「会话标识」。
 * 那个标识以前就是 QQ 群号，现在可能是 App 的 threadId。
 *
 * 必须分流的硬理由：src/transport/onebot.js:264 是
 *   `group_id: Number(groupId)`
 * 而 Number('t123abc') === NaN，JSON 序列化后变 null。
 * 也就是说 threadId 走 QQ 通道不会报错，消息会静默发到一个空群。
 * 这种「不报错但没送到」是最难查的一类 bug，所以分流必须显式。
 *
 * 判定规则：threadId 以 't' 开头（见 api/threads.js 的 newThreadId）。
 * QQ 群号全是数字，两者天然不冲突，不需要额外的类型字段。
 */
import { readFileSync } from 'node:fs'

/**
 * App 会话的标识前缀，和 api/threads.js 的 newThreadId 保持一致。
 * 前缀后至少还要有 2 个字符：单独一个 't' 更可能是笔误或脏数据，
 * 不该被当成合法会话放过去。
 */
const APP_PREFIX = 't'

export function isAppThread(conversationId) {
  const s = String(conversationId ?? '')
  return s.length > 2 && s.startsWith(APP_PREFIX) && !/^\d+$/.test(s)
}

/**
 * 建一个把消息同时送往「QQ 群」和「App」的传输门面。
 *
 * @param {object} o
 * @param {object} o.bot              OneBot 实例（可能没连，别的地方会判 connected）
 * @param {import('./messages.js').MessageStore} o.messages
 * @param {import('./artifacts.js').ArtifactStore} o.artifacts
 * @param {(...a:any[])=>void} o.log
 */
export function createTransport({ bot, messages, artifacts, log }) {
  /**
   * 发纯文本。
   *
   * 两条路都要落库——App 里也应该看到「发给 QQ 群的那条播报」吗？
   * 不。两者是并列的通道，不是主从。QQ 群里的播报属于那个群，
   * App 的会话属于 App。所以只往当前通道落。
   */
  async function sendText(conversationId, text, { replyTo = null } = {}) {
    const id = String(conversationId)
    if (isAppThread(id)) {
      try {
        messages.append(id, { role: 'bot', kind: 'text', payload: { text } })
      } catch (err) {
        log(`[${id}] 消息落库失败：${err.message}`)
      }
      return
    }
    await bot.sendGroupMsg(id, text)
  }

  /**
   * 发图片。
   *
   * QQ 那边原来发 base64 是因为 NapCat 可能在 Docker 里看不到宿主机路径。
   * App 这边直接落成产物文件给 URL，比自己再拼 base64 省带宽——
   * 一张设计稿动辄几 MB，base64 还要再大 33%。
   */
  async function sendImage(conversationId, { buffer, name }, { replyTo = null } = {}) {
    const id = String(conversationId)
    const fileName = name || 'image.png'
    if (isAppThread(id)) {
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
      return
    }
    await bot.sendGroupMsg(id, [
      { type: 'image', data: { file: `base64://${buffer.toString('base64')}` } },
    ])
  }

  /**
   * 发文件。
   *
   * QQ：原样走 uploadGroupFile（它自己会读文件并转 base64）。
   * App：读进产物目录，落一条 file 消息。读取用 try 包住——
   * 产物文件可能被人工清理掉，那时不该让整个回合崩。
   */
  async function sendFile(conversationId, filePath, name, { replyTo = null } = {}) {
    const id = String(conversationId)
    if (isAppThread(id)) {
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
      return
    }
    await bot.uploadGroupFile(id, filePath, name)
  }

  /**
   * 记一条结构化事件（阶段变化、待决策卡片）。
   * QQ 那边不需要，它靠文本播报就够；App 这边要画成卡片。
   */
  function event(conversationId, kind, payload) {
    const id = String(conversationId)
    if (!isAppThread(id)) return
    try {
      messages.append(id, { role: 'bot', kind, payload })
    } catch (err) {
      log(`[${id}] 事件落库失败：${err.message}`)
    }
  }

  return { sendText, sendImage, sendFile, event, isAppThread }
}
