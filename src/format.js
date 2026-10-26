/**
 * 推送到群的消息整形：分条、限流、清洗 markdown。
 *
 * QQ 不渲染表格、不认 html，长文一口气发会被截断且刷屏，所以这里统一处理。
 */

/** 去掉 QQ 里只会变成乱码的 markdown 结构，保留可读文本 */
export function sanitize(text) {
  let s = text ?? ''

  // 去掉代码块围栏，保留内容
  s = s.replace(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm, (_, body) => body)

  // 表格 → 每行用「 | 」保留结构，去掉分隔行
  s = s.split('\n')
    .filter((line) => !/^\s*\|?[\s:-]+\|[\s:|-]*$/.test(line))
    .join('\n')
  s = s.replace(/^\s*\|(.+)\|\s*$/gm, (_, inner) =>
    inner.split('|').map((c) => c.trim()).filter(Boolean).join(' | '),
  )

  // 标题符号、粗体、行内代码
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')

  // 连续空行压成一个
  s = s.replace(/\n{3,}/g, '\n\n')

  return s.trim()
}

/**
 * 按段落切成多条，尽量在空行/句末断开。
 * @param {string} text
 * @param {number} chunkChars 单条目标字数
 * @param {number} maxChunks 最多几条
 */
export function splitChunks(text, chunkChars, maxChunks) {
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= chunkChars) return [clean]

  const paras = clean.split(/\n{2,}/)
  const out = []
  let buf = ''

  const push = () => {
    if (buf.trim()) out.push(buf.trim())
    buf = ''
  }

  for (const p of paras) {
    if (p.length > chunkChars) {
      push()
      // 超长段落按句末切
      const sentences = p.split(/(?<=[。！？；\n])/)
      for (const s of sentences) {
        if ((buf + s).length > chunkChars) push()
        buf += s
      }
      continue
    }
    if ((buf + '\n\n' + p).length > chunkChars) push()
    buf += (buf ? '\n\n' : '') + p
  }
  push()

  if (out.length <= maxChunks) return out
  const kept = out.slice(0, maxChunks)
  kept.push(`…（后续还有 ${out.length - maxChunks} 段，完整内容见落盘文件）`)
  return kept
}

/** 简单令牌桶：单群每分钟最多 N 条 */
export class RateLimiter {
  constructor(maxPerMinute) {
    this.max = maxPerMinute
    this.windowStart = 0
    this.count = 0
  }

  /** 返回需要等待的毫秒数，0 表示可以立即发 */
  delayFor() {
    const now = Date.now()
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now
      this.count = 0
    }
    if (this.count < this.max) {
      this.count++
      return 0
    }
    return 60_000 - (now - this.windowStart)
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 毫秒 →「1天1小时1分钟30秒」。为 0 的单位整段省略，不补零：
 *   30 秒      → 30秒
 *   90 秒      → 1分钟30秒
 *   3661 秒    → 1小时1分钟1秒
 *   90061 秒   → 1天1小时1分钟1秒
 * 不足 1 秒说「不到1秒」，避免出现「0秒」这种看着像没在跑的说法。
 */
export function formatDuration(ms) {
  if (ms == null) return null
  const total = Math.floor(Math.max(0, ms) / 1000)
  if (total === 0) return '不到1秒'

  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  let out = ''
  if (d) out += `${d}天`
  if (h) out += `${h}小时`
  if (m) out += `${m}分钟`
  if (s) out += `${s}秒`
  return out
}
