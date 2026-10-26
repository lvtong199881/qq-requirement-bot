/**
 * 消息路由模板：每类用户消息最终送给 agent 的 prompt，可在面板里编辑。
 *
 * 变量（渲染时替换）：
 *   {{target}}        「需求 xxx」或「当前需求」
 *   {{stage}}         当前阶段名，没有则「当前」
 *   {{userText}}      用户原话
 *   {{rejectReason}}  打回时的修改意见（没有则回退到 userText）
 *   {{waitingLabel}}  当前在等什么
 *
 * 校验只拦「改坏了会静默失效」的情况：空模板、未知占位符。
 */

export const ROUTE_VARS = {
  target: '「需求 xxx」或「当前需求」',
  stage: '当前阶段名，没有时为「当前」',
  userText: '用户原话',
  rejectReason: '打回时的修改意见',
  waitingLabel: '当前在等什么',
}

/** 路由定义：key 与 INTENT 对应 */
export const ROUTES = {
  approve: {
    label: '批准（通过 / ok）',
    desc: '用户回复「通过」「好的」「ok」时发给 agent 的内容',
    vars: ['target', 'stage'],
    template: `用户批准了{{target}}的「{{stage}}」阶段。
执行准出流转：核对编排记录的准出清单，确认无未闭环项后进入下一阶段；
若有未闭环项，按 skill 规则处理并如实说明。`,
  },
  reject: {
    label: '打回（打回 / 不行）',
    desc: '用户打回当前阶段并给出修改意见',
    vars: ['target', 'stage', 'rejectReason', 'userText'],
    template: `用户打回了{{target}}的「{{stage}}」阶段。
修改意见如下：
{{rejectReason}}
按 skill 规则把这条意见转给对应阶段的 agent 修正，不要自己动手改产物。`,
  },
  continue: {
    label: '继续（继续 / 接着跑）',
    desc: '用户要求接着推进当前需求',
    vars: ['target'],
    template: `用户要求继续推进{{target}}。
先读编排记录，从停下的地方继续；未回填的用户裁决要先回填。`,
  },
  new_req: {
    label: '新需求（新需求 xxx）',
    desc: '用户要开一个新需求',
    vars: ['userText'],
    template: `用户要开一个新需求。先清点当前绑定需求的收尾状态（编排记录）并简要告知，
然后按 skill 流程受理新需求。用户原话：
「{{userText}}」`,
  },
  content: {
    label: '普通内容 / 回答追问',
    desc: '用户发的是需求描述、或对上一条提问的回答。若群里有「在等什么」，会走下面这段；没有则原样透传用户消息。',
    vars: ['target', 'waitingLabel', 'userText'],
    template: `当前{{target}}在等你处理：{{waitingLabel}}
用户的回复如下，请对照等待事项解析并继续：
「{{userText}}」`,
  },
}

/** 校验单条路由模板 */
export function validateRouteTemplate(key, text) {
  const def = ROUTES[key]
  if (!def) return { ok: false, error: `未知路由：${key}` }

  const t = typeof text === 'string' ? text : ''
  if (!t.trim()) return { ok: false, error: '模板不能为空' }
  if (t.length > 4000) return { ok: false, error: `太长（${t.length} 字符），上限 4000` }

  const used = [...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
  const allowed = Object.keys(ROUTE_VARS)
  const bad = [...new Set(used.filter((v) => !allowed.includes(v)))]
  if (bad.length) {
    return {
      ok: false,
      error: `未知占位符 ${bad.map((v) => `{{${v}}}`).join('、')}，可用：${allowed.map((v) => `{{${v}}}`).join('、')}`,
    }
  }
  return { ok: true }
}

/** 批量校验（面板保存时用） */
export function validateAllRoutes(patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: '格式错误' }
  for (const [key, text] of Object.entries(patch)) {
    const r = validateRouteTemplate(key, text)
    if (!r.ok) return { ok: false, error: `${ROUTES[key]?.label ?? key}：${r.error}` }
  }
  return { ok: true }
}

/**
 * 渲染一条路由。
 * @param {string} key 路由 key（approve / reject / continue / new_req / content）
 * @param {object} vals 变量值
 * @param {object=} overrides 用户自定义模板（key → template）
 */
export function renderRoute(key, vals, overrides) {
  const custom = overrides?.[key]
  const tpl = typeof custom === 'string' && custom.trim() ? custom : ROUTES[key]?.template
  if (!tpl) return ''

  return tpl.replace(/\{\{(\w+)\}\}/g, (m, name) => {
    const v = vals[name]
    return v === undefined || v === null ? '' : String(v)
  })
}
