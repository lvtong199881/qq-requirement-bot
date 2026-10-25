/**
 * 极简 Mock OneBot 服务端，只用于本地端到端测试。
 * 手写 WebSocket 握手与帧编解码，避免为一个测试引入依赖。
 *
 * 能力：
 * - 接受 bridge 的正向 WS 连接
 * - 注入一条群消息事件（模拟用户 @产品同学）
 * - 记录 bridge 调过来的 API（send_group_msg 等）
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x81 // FIN + text
  return Buffer.concat([header, payload])
}

/** 解析客户端发来的帧（只处理文本帧与掩码） */
function decodeFrames(buf, onText) {
  let offset = 0
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset]
    const b1 = buf[offset + 1]
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = offset + 2

    if (len === 126) {
      if (p + 2 > buf.length) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (p + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }

    const maskLen = masked ? 4 : 0
    if (p + maskLen + len > buf.length) break

    const mask = masked ? buf.subarray(p, p + 4) : null
    p += maskLen
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]

    const opcode = b0 & 0x0f
    if (opcode === 0x1) onText(payload.toString('utf8'))
    if (opcode === 0x8) return { consumed: buf.length, closed: true }

    offset = p + len
  }
  return { consumed: offset, closed: false }
}

export function startMockOneBot({ port = 0, selfId = 10000, token = '', groupId = 123456 } = {}) {
  const calls = []
  const sockets = new Set()

  const server = createServer((req, res) => {
    res.writeHead(404).end()
  })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    const conn = { socket, ready: true }
    sockets.add(conn)

    // 连上后先发一条生命周期事件，让 bridge 拿到 self_id
    setTimeout(() => {
      try {
        socket.write(
          encodeFrame(
            JSON.stringify({
              time: Math.floor(Date.now() / 1000),
              self_id: selfId,
              post_type: 'meta_event',
              meta_event_type: 'lifecycle',
              sub_type: 'connect',
            }),
          ),
        )
      } catch {
        /* ignore */
      }
    }, 50)

    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      const { consumed } = decodeFrames(pending, (text) => {
        let frame
        try {
          frame = JSON.parse(text)
        } catch {
          return
        }
        calls.push(frame)
        // 回一个成功响应
        // 回一个成功响应；get_group_list / get_group_info 返回真实结构
        let data
        if (frame.action === 'get_group_list') {
          data = [
            { group_id: Number(groupId), group_name: '测试需求群', member_count: 3, max_member_count: 200 },
          ]
        } else if (frame.action === 'get_group_info') {
          data = {
            group_id: Number(frame.params?.group_id ?? api.groupId),
            group_name: '测试需求群',
            member_count: 3,
            max_member_count: 200,
          }
        } else {
          data = { message_id: calls.length }
        }
        const resp = { status: 'ok', retcode: 0, data, echo: frame.echo }
        try {
          socket.write(encodeFrame(JSON.stringify(resp)))
        } catch {
          /* ignore */
        }
      })
      if (consumed > 0) pending = pending.subarray(consumed)
    })

    socket.on('close', () => sockets.delete(conn))
    socket.on('error', () => sockets.delete(conn))
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()

      const api = {
        port: addr.port,
        url: `ws://127.0.0.1:${addr.port}`,
        calls,
        /** 记录到目前收到的所有 send_group_msg 文本（数组消息会抽出文本段） */
        sentTexts: () =>
          calls
            .filter((c) => c.action === 'send_group_msg')
            .map((c) => {
              const m = c.params?.message
              if (typeof m === 'string') return m
              // 引用回复是 [reply, text] 数组，取文本段拼起来
              if (Array.isArray(m)) {
                return m
                  .filter((seg) => seg?.type === 'text')
                  .map((seg) => seg.data?.text ?? '')
                  .join('')
              }
              return undefined
            })
            .filter((m) => typeof m === 'string' && m.length > 0),
        /** 原始发送参数，用于断言引用段 */
        sentRaw: () =>
          calls.filter((c) => c.action === 'send_group_msg').map((c) => c.params?.message),
        uploadedFiles: () =>
          calls.filter((c) => c.action === 'upload_group_file').map((c) => c.params),
        /** 模拟群里有人 @ 了 bot */
        sendGroupAt({ groupId, text, userId = 20000, atBot = true }) {
          const message = []
          if (atBot) message.push({ type: 'at', data: { qq: String(selfId) } })
          message.push({ type: 'text', data: { text } })
          const frame = {
            time: Math.floor(Date.now() / 1000),
            self_id: selfId,
            post_type: 'message',
            message_type: 'group',
            sub_type: 'normal',
            message_id: Math.floor(Math.random() * 1e6),
            group_id: Number(groupId),
            user_id: userId,
            raw_message: text,
            message,
            message_format: 'array',
            sender: { user_id: userId, nickname: '你' },
          }
          for (const c of sockets) {
            try {
              c.socket.write(encodeFrame(JSON.stringify(frame)))
            } catch {
              /* ignore */
            }
          }
          return frame
        },
        close: () =>
          new Promise((r) => {
            for (const c of sockets) {
              try {
                c.socket.destroy()
              } catch {
                /* ignore */
              }
            }
            sockets.clear()
            server.close(() => r())
          }),
      }
      resolve(api)
    })
  })
}
