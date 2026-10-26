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
  isAdmin: '是否为管理员（用来标注哪些指令需要权限）',
  statusLine: '当前状态一句话，可能为空',
  permissionNote: '权限说明那句',
  list: '指令列表（bridge 自动生成）',
  count: '条数',
  text: '用户原话',
  reqId: '需求标识，如 welcome-dialog（纯值）',
  reqIdPad: '需求标识，前后各带一个空格，适合嵌在句子中间',
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
  ackWaiting: {
    group: '回执（消息 1）',
    label: '有进行中阶段 · 且有待确认事项',
    desc: '阶段在跑、同时有需要用户拍板的事，两件事一起说清',
    vars: ['stage', 'duration', 'waitingLabel'],
    template: '当前{{stage}}阶段中，已进行 {{duration}}。\n等你确认：\n{{waitingLabel}}',
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
  ackPendingLabel: {
    group: '回执（消息 1）',
    label: '没有进行中阶段 · 有等待事项',
    desc: '比上一条多带出「在等什么」，用户才知道该确认什么',
    vars: ['stageDone', 'waitingLabel'],
    template: '{{stageDone}}阶段已完成，等你确认：\n{{waitingLabel}}',
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
  groupTaken: {
    group: '交互提示',
    label: '群里已有需求，不能再开新的',
    desc: '一个群只做一个需求，做完也占着这个群',
    vars: ['reqId'],
    template: '这个群已经绑定了需求「{{reqId}}」，一个群只做一个需求（做完也算）。\n新需求请另开一个群，把 bot 拉进去再 @ 它。',
  },
  allDone: {
    group: '交互提示',
    label: '需求已全部完成',
    desc: '需求收尾后，用户再发任何消息（新需求除外）都回这句',
    vars: ['reqId'],
    template: '本需求{{reqIdPad}}已全部完成，新需求请开新群。',
  },
  ambiguous: {
    group: '交互提示',
    label: '没看懂用户在说什么',
    desc: '用户发的话太短又没有明确指令，且有等待事项时',
    vars: ['waitingLabel'],
    template: '这条我没看懂要表达什么。我这边正在等你：{{waitingLabel}}\n是回复上面的问题，还是别的意思？直接说清楚就行。',
  },

  // ── 指令与操作反馈 ──
  unknownCmd: {
    group: '指令与操作',
    label: '未知指令',
    vars: ['cmd'],
    template: '没有 /{{cmd}} 这条指令。发 /help 看可用的。',
  },
  denied: {
    group: '指令与操作',
    label: '无权限使用指令',
    vars: ['cmd'],
    template: '/{{cmd}} 需要群主或群管理员权限。',
  },
  help: {
    group: '指令与操作',
    label: '帮助（/help）',
    desc: '指令列表由 bridge 自动生成，这里只配开头和结尾的固定话术',
    vars: ['list', 'statusLine', 'permissionNote'],
    template: '可用指令：\n\n{{list}}\n\n也可以直接说人话：「继续」「停」「打回 主按钮要蓝色的」「新需求 …」{{statusLine}}\n\n{{permissionNote}}',
  },
  stopDone: {
    group: '指令与操作',
    label: '已停止任务',
    vars: [],
    template: '已停止当前任务。',
  },
  stopNone: {
    group: '指令与操作',
    label: '停止 · 当前没任务',
    vars: [],
    template: '当前没有在跑的任务。',
  },
  interruptDone: {
    group: '指令与操作',
    label: '已打断回合',
    vars: [],
    template: '已打断当前回合。',
  },
  interruptNone: {
    group: '指令与操作',
    label: '打断 · 当前没回合',
    vars: [],
    template: '当前没有在跑的回合。',
  },
  releaseAsk: {
    group: '指令与操作',
    label: '释放确认（二次确认）',
    vars: ['target', 'stage'],
    template: '确认要释放{{target}}的会话与进程吗？\n\n会做三件事：\n· 打断当前正在跑的回合（如果有）\n· 清空这个群的会话上下文\n· 当前阶段「{{stage}}」的进度只保留在编排记录里\n\n之后需要重新发需求或「继续」才能接上。\n回复「确认」执行，回别的就取消。',
  },
  releaseAlready: {
    group: '指令与操作',
    label: '释放 · 已在等确认',
    vars: [],
    template: '已经在等你确认了，回「确认」执行，回别的取消。',
  },
  releaseCancel: {
    group: '指令与操作',
    label: '释放已取消',
    vars: [],
    template: '已取消释放。',
  },
  rejectCancel: {
    group: '指令与操作',
    label: '打回已取消',
    vars: [],
    template: '已取消打回，阶段保持原样。',
  },
  cleared: {
    group: '指令与操作',
    label: '绑定已清空',
    vars: [],
    template: '已清空。下一条消息发新需求，我来绑定。',
  },
  queued: {
    group: '指令与操作',
    label: '消息已排队',
    desc: '上一回合还在跑，这条先排队等它结束',
    vars: ['text'],
    template: '上一回合还在跑，这条已经排队，等它结束就执行：\n{{text}}',
  },
  queuedLost: {
    group: '系统通知',
    label: '重启后有没执行的消息',
    desc: 'bridge 重启导致排队消息丢失时的提醒',
    vars: ['list'],
    template: 'bridge 重启前有 {{count}} 条消息没来得及执行：\n{{list}}\n需要的话请重新发一次。',
  },
  dryRun: {
    group: '指令与操作',
    label: 'dry-run 回执',
    vars: [],
    template: '[dry-run] 收到，不实际执行。',
  },

  // ── 系统通知 ──
  sessionReset: {
    group: '系统通知',
    label: '会话被占用后重置',
    vars: [],
    template: '上一个进程没释放会话，已重置并重新开始这一轮。',
  },
  restartNotice: {
    group: '系统通知',
    label: 'bridge 重启通知',
    vars: [],
    template: 'bridge 正在重启，当前回合的结果可能不会送达。重启后发「继续」可以接着跑。',
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
