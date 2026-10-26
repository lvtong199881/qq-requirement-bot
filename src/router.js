/**
 * 消息语义路由 + 需求绑定 + 编排锚点 —— 防走偏的核心。
 *
 * 设计立场：LLM 拿到含糊输入时会用「看到的东西」补全意图，所以
 * 决定权必须从 agent 手里收回来。agent 只回答 bridge 给出的确定问题，
 * 不自己挑活、不自己解读用户意图。
 */

/** 消息意图分类 */
import { renderRoute } from './routes.js'

export const INTENT = {
  APPROVE: 'approve', // 批准当前阶段
  REJECT: 'reject', // 打回（带修改意见）
  CONTINUE: 'continue', // 继续
  NEW_REQ: 'new_req', // 新需求（换绑）
  STOP: 'stop',
  HELP: 'help',
  INFO: 'info', // 本群/群信息
  AMBIGUOUS: 'ambiguous', // 含糊：bridge 反问消歧
  CONTENT: 'content', // 正常内容（需求描述/对提问的回答）
}

/** 批准词 */
const APPROVE_RE = /^(通过|ok|OK|Okay|好的|可以|同意|批准|lgtm|LGTM)[\s,，。!！.]*$/
/** 打回词 */
// 允许「打回」后面直接跟修改意见，否则用户说完打回就没机会说了
const REJECT_RE = /^(打回|不行|不对|有问题|重做)[\s,，。!！:：]*(.*)$/
/** 继续词 */
const CONTINUE_RE = /^(继续|接着跑|接着来|go|GO)[\s,，。!！.]*$/
/** 新需求词（带可选描述） */
const NEW_REQ_RE = /^(新需求|重开|新任务)([\s:：]+(.*))?$/
/** 停词 */
const STOP_WORDS = new Set(['停', '停止', '中断', '停一下', '取消'])
const HELP_WORDS = new Set(['帮助', 'help', '?', '？', '怎么用'])
const INFO_WORDS = new Set(['本群', '群信息', '状态'])

/**
 * 判定用户消息意图。规则简单直接，不用 LLM。
 * @param {string} text 已去掉 @ 的正文
 * @returns {{intent: string, detail?: string}}
 */
export function classifyMessage(text) {
  const t = (text ?? '').trim()
  if (!t) return { intent: INTENT.CONTENT }

  if (STOP_WORDS.has(t)) return { intent: INTENT.STOP }
  if (HELP_WORDS.has(t)) return { intent: INTENT.HELP }
  if (INFO_WORDS.has(t)) return { intent: INTENT.INFO }

  const approve = t.match(APPROVE_RE)
  if (approve) return { intent: INTENT.APPROVE }

  const reject = t.match(REJECT_RE)
  if (reject) return { intent: INTENT.REJECT, detail: (reject[2] || '').trim() }

  const cont = t.match(CONTINUE_RE)
  if (cont) return { intent: INTENT.CONTINUE }

  const nr = t.match(NEW_REQ_RE)
  if (nr) return { intent: INTENT.NEW_REQ, detail: (nr[3] || '').trim() }

  return { intent: INTENT.CONTENT }
}

/**
 * 含糊消息判定：消息很短、不是已识别意图、且当前有挂起的等待事项。
 * 这类消息不能交给 agent 猜——bridge 直接反问用户。
 * @param {string} text
 * @param {{waitingLabel: string}|null} state
 */
export function isAmbiguous(text, state) {
  const t = (text ?? '').trim()
  // 有结构的长句（带标点分句或超过 16 字）不算含糊：
  // 真实需求描述常在 15-30 字之间，不能只看长度
  if (t.length > 16) return false
  if (/[，。；、]/.test(t)) return false
  if (classifyMessage(t).intent !== INTENT.CONTENT) return false
  // 有明确等待事项、且消息短到看不出针对性 → 反问
  return !!state?.waitingLabel
}

/**
 * 从编排记录取绑定需求当前快照，生成锚点。
 * @param {object} opts
 * @param {string} opts.reqId 绑定的需求标识
 * @param {string} opts.projectDir
 * @param {string|null} opts.stage 当前阶段（可为空）
 * @returns {string}
 */
export function anchorBlock({ reqId, projectDir, stage, envHints }) {
  const lines = [
    '【需求锚点——本会话唯一工作目标】',
    `需求标识：${reqId}`,
    `编排记录：docs/requirements/${reqId}/编排记录.md`,
    stage ? `当前阶段：${stage}` : '当前阶段：以编排记录为准',
    '',
    '硬性边界：',
    `- 你只做 ${reqId} 这一个需求。`,
    '- 禁止读取、修改、接手 docs/requirements/ 下其他需求的任何文件。',
    '- 禁止接手项目里的其他工作，哪怕看起来「更有价值」或「正在进行」。',
    '- 项目里可能有其他需求在进行中，那些都不归你管，也不要在回复里提它们。',
    '- 你的每一步都要以编排记录为准：先读它，从停下的地方继续，不要从头重跑。',
  ]
  if (envHints) {
    lines.push('', '【本机环境（已核实，不要再自己猜）】', envHints)
  }
  return lines.join('\n')
}

/**
 * 按意图生成确定性的 prompt 骨架。agent 只填执行，不选方向。
 * @param {object} o
 * @param {string} o.intent
 * @param {string} o.userText 原文
 * @param {{reqId: string|null, stage: string|null, waitingLabel: string}} o.bind 绑定信息
 */
/**
 * 生成送给 agent 的 prompt。
 *
 * 内容来自 routes.js 的模板（可在面板里改），这里只负责把变量算好。
 * @param {{intent: string, userText: string, bind: object, routes?: object}} o
 */
export function routedPrompt({ intent, userText, bind, routes }) {
  const target = bind.reqId ? `需求 ${bind.reqId}` : '当前需求'
  const stage = bind.stage || '当前'
  const vals = {
    target,
    stage,
    userText,
    // 打回没写意见时，退回用户原话，避免模板里空一段
    rejectReason: (bind.rejectReason || '').trim() || userText,
    waitingLabel: bind.waitingLabel || '',
  }

  switch (intent) {
    case INTENT.APPROVE:
      return renderRoute('approve', vals, routes)
    case INTENT.REJECT:
      return renderRoute('reject', vals, routes)
    case INTENT.CONTINUE:
      return renderRoute('continue', vals, routes)
    case INTENT.NEW_REQ:
      return renderRoute('new_req', vals, routes)
    case INTENT.CONTENT:
    default:
      // 没有等待事项时原样透传用户消息——不套模板，保持原话
      if (!bind.waitingLabel) return userText
      return renderRoute('content', vals, routes)
  }
}

/**
 * 含糊消息的反问文案。
 * @param {string} waitingLabel
 */
export function ambiguousReply(waitingLabel) {
  return `这条我没看懂要表达什么。我这边正在等你：${waitingLabel}\n是回复上面的问题，还是别的意思？直接说清楚就行。`
}
