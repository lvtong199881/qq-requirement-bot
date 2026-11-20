/**
 * 时长格式化，以及一个 sleep。
 *
 * 以前这里还有 sanitize / splitChunks / RateLimiter——那是给 QQ 用的：
 * QQ 不渲染 markdown、单条有字数上限、发太快会风控。App 这三件事都不存在，
 * 那三个函数一直没人调用，删 QQ 时一起清掉了。
 */

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
