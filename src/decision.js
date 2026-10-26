/**
 * 决策内容：agent 输出 JSON，bridge 负责渲染成给人看的文本。
 *
 * 约定 agent 用 [[ASK]] 标记后面跟一个 JSON 数组：
 *
 *   [
 *     { "q": "问题1", "a": [ { "t": "答案1", "r": true }, { "t": "答案2", "r": false } ] },
 *     { "q": "问题2", "a": [ { "t": "答案1", "r": false }, { "t": "答案2", "r": true } ] }
 *   ]
 *
 *   q = 问题（事项标题）
 *   a = 选项数组，t = 选项文本，r = 是否推荐
 *
 * 渲染成：
 *
 *   1. 问题1
 *      A. 答案1（推荐）
 *      B. 答案2
 *
 * 为什么用 JSON 而不是约束文本排版：文本格式要纠结分隔符、缩进、空行，
 * agent 稍有偏差就得整条退回；JSON 只有「解析得通 / 解析不通」两种结果，
 * 结构校验也能逐字段说清哪里不对。
 */

/** 数量上限，防止 agent 一口气甩出二十个问题 */
const MAX_ITEMS = 5
const MAX_OPTIONS = 4

/** 剥掉 markdown 代码围栏，agent 常习惯包一层 ```json */
function stripFence(text) {
  return String(text ?? '')
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim()
}

/** 从一段可能夹着杂质的文本里取出第一个 JSON 数组 */
function extractArray(text) {
  const start = text.indexOf('[')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 解析 JSON 结构，逐字段校验。
 * @returns {{ok: true, items: Array<{no:number,title:string,options:Array<{key:string,text:string,recommended:boolean}>}>}
 *          | {ok: false, reason: string}}
 */
export function parseDecisionJson(raw) {
  const body = stripFence(raw)
  if (!body) return { ok: false, reason: '内容为空' }

  // 先按整段解析——这样「给了个对象而不是数组」能报出准确原因；
  // 整段解析不通（前后夹了废话、包了代码块）再退到括号匹配提取数组。
  let data = null
  let parseError = null
  try {
    data = JSON.parse(body)
  } catch (err) {
    parseError = err
  }

  if (data === null) {
    const jsonText = extractArray(body)
    if (!jsonText) return { ok: false, reason: '没找到 JSON 数组（应以 [ 开头）' }
    try {
      data = JSON.parse(jsonText)
    } catch (err) {
      return { ok: false, reason: `JSON 解析失败：${(parseError ?? err).message}` }
    }
  }

  if (!Array.isArray(data)) return { ok: false, reason: '最外层必须是数组，不要给对象' }
  if (!data.length) return { ok: false, reason: '数组是空的，至少要有 1 个问题' }
  if (data.length > MAX_ITEMS) {
    return { ok: false, reason: `问题太多（${data.length} 个），最多 ${MAX_ITEMS} 个` }
  }

  const items = []
  for (let i = 0; i < data.length; i++) {
    const it = data[i]
    const at = `第 ${i + 1} 个问题`
    if (!it || typeof it !== 'object') return { ok: false, reason: `${at}不是对象` }

    const q = typeof it.q === 'string' ? it.q.trim() : ''
    if (!q) return { ok: false, reason: `${at}缺少 q（问题标题）` }

    if (!Array.isArray(it.a)) return { ok: false, reason: `${at}的 a 必须是数组` }
    if (!it.a.length) return { ok: false, reason: `${at}没有任何选项` }
    if (it.a.length > MAX_OPTIONS) {
      return { ok: false, reason: `${at}有 ${it.a.length} 个选项，最多 ${MAX_OPTIONS} 个` }
    }

    const options = []
    for (let j = 0; j < it.a.length; j++) {
      const opt = it.a[j]
      const oat = `${at}的第 ${j + 1} 个选项`
      if (!opt || typeof opt !== 'object') return { ok: false, reason: `${oat}不是对象` }
      const t = typeof opt.t === 'string' ? opt.t.trim() : ''
      if (!t) return { ok: false, reason: `${oat}缺少 t（选项文本）` }
      options.push({
        key: String.fromCharCode(65 + j), // A / B / C / D
        text: t,
        recommended: opt.r === true,
      })
    }

    items.push({ no: i + 1, title: q, options })
  }

  return { ok: true, items }
}

/** 渲染成给人看的文本：事项顶格、选项缩进 3 空格、推荐项标「（推荐）」 */
export function formatDecision(items) {
  return items
    .map((it) => {
      const head = `${it.no}. ${it.title}`
      const opts = it.options.map(
        (o) => `   ${o.key}. ${o.text}${o.recommended ? '（推荐）' : ''}`,
      )
      return [head, ...opts].join('\n')
    })
    .join('\n')
}

/** 给重试提示用：把约定格式原样贴回去 */
export const DECISION_JSON_EXAMPLE = `[
  { "q": "<问题1的标题>", "a": [ { "t": "<选项A的文字>", "r": true }, { "t": "<选项B的文字>", "r": false } ] },
  { "q": "<问题2的标题>", "a": [ { "t": "<选项A的文字>", "r": false }, { "t": "<选项B的文字>", "r": true } ] }
]`

export const DECISION_LIMITS = { MAX_ITEMS, MAX_OPTIONS }
