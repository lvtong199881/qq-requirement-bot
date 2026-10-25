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
 * 把毫秒差说成「9 分钟」。时间戳缺失返回 null——宁可不说，也别显示「0 分钟」。
 * 曾经因为 stageStartedAt 没被设置，群里播报了「已进行 0 分钟」。
 */
export function minsText(fromTs) {
  if (!fromTs) return null
  const ms = Date.now() - fromTs
  if (ms < 60_000) return '不到 1 分钟'
  return `${Math.round(ms / 60000)} 分钟`
}

/** 「当前XX阶段中，已进行X分钟」——时长未知时省略时长 */
export function runningText(stageName, fromTs) {
  const dur = minsText(fromTs)
  return dur ? `当前${stageName}阶段中，已进行 ${dur}。` : `当前${stageName}阶段进行中。`
}
