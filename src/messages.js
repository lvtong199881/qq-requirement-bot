/**
 * bot 发给群的文案模板——面板里可改。
 *
 * 注意和另外两个模块的区别：
 *   prompt.js   → 注入给 agent 的群聊协议（agent 读的）
 *   routes.js   → 每条用户消息转成 agent 的 prompt（agent 读的）
 *   messages.js → bot 在群里说的话（用户读的）← 就是这里
 *
 * 变量渲染时会替换，未知占位符校验时拒绝。
 */

export const MESSAGE_VARS = {
  stage: '阶段名，如「开发」',
  duration: '已进行时长，如「1小时2分钟」',
  stageDone: '刚完成的阶段名',
  stageStarted: '刚开始的阶段名',
  target: '「需求 xxx」或「当前需求」',
  reason: '异常原因',
  content: '需要用户决定的内容',
  artifacts: '产物文件名，顿号分隔',
  action: '用户动作的简述（收到批准 / 收到修改意见 …）',
  cmd: '指令名，如 stop',
  waitingLabel: '当前在等什么',
}

export const MESSAGE_TEMPLATES = {
  // ── 消息 1：用户发消息后的回执 ──
  ack: {
    group: '回执（消息 1）',
    label: '有进行中阶段',
    desc: '用户发任何消息后立刻回的一句状态',
    vars: ['stage', 'duration'],
    template: '当前{{stage}}阶段中，已进行 {{duration}}。',
  },
  ackApprove: {
    group: '回执（消息 1）',
    label: '没有进行中阶段 · 用户批准',
    vars: ['stageDone'],
    template: '{{stageDone}}阶段已完成，收到批准，正在启动下一阶段。',
  },
  ackReject: {
    group: '回执（消息 1）',
    label: '没有进行中阶段 · 用户打回',
    vars: ['stageDone'],
    template: '{{stageDone}}阶段已完成，收到修改意见，正在转给对应阶段处理。',
  },
  ackContinue: {
    group: '回执（消息 1）',
    label: '没有进行中阶段 · 用户说继续',
    vars: ['stageDone'],
    template: '{{stageDone}}阶段已完成，正在继续。',
  },
  ackNewReq: {
    group: '回执（消息 1）',
    label: '没有进行中阶段 · 新需求',
    vars: [],
    template: '收到，开始新需求。',
  },
  ackPending: {
    group: '回执（消息 1）',
    label: '没有进行中阶段 · 其他情况',
    desc: '有已完成阶段、但用户这句话不匹配上面几种意图时',
    vars: ['stageDone'],
    template: '{{stageDone}}阶段已完成，等你确认。',
  },
  ackIdle: {
    group: '回执（消息 1）',
    label: '完全没有阶段',
    vars: [],
    template: '当前没有进行中的阶段。',
  },

  // ── 消息 2：阶段播报 ──
  stageStart: {
    group: '阶段播报（消息 2）',
    label: '阶段已开始',
    vars: ['stage'],
    template: '{{stage}}阶段已开始。',
  },
  stageDone: {
    group: '阶段播报（消息 2）',
    label: '阶段已完成',
    vars: ['stage', 'artifacts'],
    template: '{{stage}}阶段已完成。',
  },
  stageAdvance: {
    group: '阶段播报（消息 2）',
    label: '阶段推进（完成 + 开始）',
    desc: '一个回合里既有阶段完成又有新阶段开始时，合成一句',
    vars: ['stageDone', 'stageStarted'],
    template: '{{stageDone}}阶段已完成，{{stageStarted}}阶段已开始。',
  },
  artifactsLine: {
    group: '阶段播报（消息 2）',
    label: '产物清单（附在完成消息后）',
    vars: ['artifacts'],
    template: '产物：{{artifacts}}',
  },

  // ── 消息 3：心跳 ──
  heartbeat: {
    group: '其他',
    label: '心跳（消息 3）',
    vars: ['stage', 'duration'],
    template: '当前{{stage}}阶段中，已进行 {{duration}}。',
  },

  // ── 消息 4：异常 ──
  abnormal: {
    group: '其他',
    label: '异常播报（消息 4）',
    vars: ['stage', 'reason'],
    template: '{{stage}}阶段异常，请联系 bot 管理员，异常原因如下：\n{{reason}}',
  },

  // ── 交互提示 ──
  decision: {
    group: '交互提示',
    label: '需要决策',
    desc: 'agent 请求你拍板时，内容前面的标签',
    vars: ['content'],
    template: '需要决策：\n{{content}}',
  },
  rejectAsk: {
    group: '交互提示',
    label: '打回追问（要修改意见）',
    vars: ['stage'],
    template: '收到，打回{{stage}}阶段，请提供修改意见。\n（回「取消」可以撤销打回）',
  },
  idleHint: {
    group: '交互提示',
    label: '空消息引导',
    desc: '用户只 @ 了 bot 什么都没说、且这个群还没开始任何需求时',
    vars: [],
    template: '直接把需求说给我就行，比如「首页加个欢迎弹窗，手动批准」。',
  },
  done: {
    group: '交互提示',
    label: '需求全部完成',
    vars: [],
    template: '这个需求跑完了。要新需求直接 @我 说。',
  },
}

/** 校验单条模板 */
export function validateMessageTemplate(key, text) {
  const def = MESSAGE_TEMPLATES[key]
  if (!def) return { ok: false, error: `未知文案：${key}` }

  const t = typeof text === 'string' ? text : ''
  if (!t.trim()) return { ok: false, error: '不能为空' }
  if (t.length > 2000) return { ok: false, error: `太长（${t.length} 字符），上限 2000` }

  const used = [...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
  const bad = [...new Set(used.filter((v) => !(v in MESSAGE_VARS)))]
  if (bad.length) {
    return {
      ok: false,
      error: `未知占位符 ${bad.map((v) => `{{${v}}}`).join('、')}，可用：${def.vars.length ? def.vars.map((v) => `{{${v}}}`).join('、') : '无'}`,
    }
  }
  return { ok: true }
}

/** 批量校验 */
export function validateAllMessages(patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: '格式错误' }
  for (const [key, text] of Object.entries(patch)) {
    const r = validateMessageTemplate(key, text)
    if (!r.ok) return { ok: false, error: `${MESSAGE_TEMPLATES[key]?.label ?? key}：${r.error}` }
  }
  return { ok: true }
}

/**
 * 渲染一条文案。
 * @param {string} key
 * @param {object} vals 变量值
 * @param {object=} overrides 自定义模板
 */
export function renderMessage(key, vals = {}, overrides) {
  const custom = overrides?.[key]
  const tpl = typeof custom === 'string' && custom.trim() ? custom : MESSAGE_TEMPLATES[key]?.template
  if (!tpl) return ''
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, name) => {
    const v = vals[name]
    return v === undefined || v === null ? '' : String(v)
  })
}
