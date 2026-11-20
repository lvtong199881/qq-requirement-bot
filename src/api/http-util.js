/**
 * HTTP 小工具：JSON 响应 + 读 body。
 *
 * 单独一个文件是因为 App API（server.js）和引擎通道（engine.js）都要用。
 * 两边各写一份的话，超时/超限这些安全相关的行为迟早会走岔。
 */

export function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

export async function readBody(req, { limit = 1_000_000 } = {}) {
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
