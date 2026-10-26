/**
 * 决策内容的格式约束。
 *
 * agent 的 ASK 段不允许自由发挥，必须是：
 *
 *   1. 事项标题
 *      A. 选项
 *      B. 选项
 *   2. 另一个事项
 *      A. 选项
 *
 * 解析时对分隔符宽松（. 、 ) ．都认），输出时统一成「1. 」和「A. 」（选项缩进 3 空格），
 * 这样群里看到的排版始终一致。解析不通过就不转发原文——否则约束形同虚设。
 */

/** 事项行：`1. 标题` / `1、标题` / `1) 标题` */
const ITEM_RE = /^\s*(\d+)\s*[.、)．]\s*(.+)$/
/** 选项行：`A. 文本` / `A、文本` / `A) 文本` */
const OPTION_RE = /^\s*([A-Za-z])\s*[.、)．]\s*(.+)$/

/**
 * @param {string} raw ASK 段原文
 * @returns {{ok: true, items: Array<{no: number, title: string, options: Array<{key: string, text: string}>}>}
 *          | {ok: false, reason: string}}
 */
export function parseDecision(raw) {
  const text = String(raw ?? '')
  if (!text.trim()) return { ok: false, reason: '内容为空' }

  const items = []
  let cur = null
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const mItem = line.match(ITEM_RE)
    if (mItem) {
      cur = { no: Number(mItem[1]), title: mItem[2].trim(), options: [] }
      items.push(cur)
      continue
    }

    const mOpt = line.match(OPTION_RE)
    if (mOpt) {
      if (!cur) {
        return { ok: false, reason: `第 ${i + 1} 行的选项「${mOpt[1].toUpperCase()}」上面没有对应的事项编号` }
      }
      cur.options.push({ key: mOpt[1].toUpperCase(), text: mOpt[2].trim() })
      continue
    }

    return {
      ok: false,
      reason: `第 ${i + 1} 行既不是「1. 标题」也不是「A. 选项」：${line.trim().slice(0, 40)}`,
    }
  }

  if (!items.length) return { ok: false, reason: '没有任何「1. 标题」形式的事项' }

  const noOptions = items.filter((it) => !it.options.length)
  if (noOptions.length) {
    return { ok: false, reason: `事项 ${noOptions.map((it) => it.no).join('、')} 下面没有选项` }
  }

  // 编号重复/乱序不致命，但要有序号；统一按出现顺序重排，避免 agent 写成 1、1、2
  const seen = new Set()
  for (const it of items) {
    if (seen.has(it.no)) return { ok: false, reason: `事项编号 ${it.no} 重复` }
    seen.add(it.no)
  }

  return { ok: true, items }
}

/** 把解析结果排成统一格式：事项顶格、选项缩进 3 空格 */
export function formatDecision(items) {
  return items
    .map((it) => {
      const head = `${it.no}. ${it.title}`
      const opts = it.options.map((o) => `   ${o.key}. ${o.text}`)
      return [head, ...opts].join('\n')
    })
    .join('\n')
}
