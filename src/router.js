/**
 * 消息语义路由 + 需求绑定 + 编排锚点 —— 防走偏的核心。
 *
 * 设计立场：LLM 拿到含糊输入时会用「看到的东西」补全意图，所以
 * 决定权必须从 agent 手里收回来。agent 只回答 bridge 给出的确定问题，
 * 不自己挑活、不自己解读用户意图。
 */

/** 消息意图分类 */
import { renderMessage } from './messages.js'

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
export function routedPrompt({ intent, userText, bind }) {
  const reqId = bind.reqId
  const stage = bind.stage || '当前'

  switch (intent) {
    case INTENT.APPROVE:
      return [
        `用户批准了${reqId ? `需求 ${reqId}` : '当前需求'}的「${stage}」阶段。`,
        '执行准出流转：核对编排记录的准出清单，确认无未闭环项后进入下一阶段；',
        '若有未闭环项，按 skill 规则处理并如实说明。',
      ].join('\n')

    case INTENT.REJECT: {
      const opinion = (bind.rejectReason || '').trim()
      return [
        `用户打回了${reqId ? `需求 ${reqId}` : '当前需求'}的「${stage}」阶段。`,
        '修改意见如下：',
        opinion || userText,
        '按 skill 规则把这条意见转给对应阶段的 agent 修正，不要自己动手改产物。',
      ].join('\n')
    }

    case INTENT.CONTINUE:
      return [
        `用户要求继续推进${reqId ? `需求 ${reqId}` : '当前需求'}。`,
        '先读编排记录，从停下的地方继续；未回填的用户裁决要先回填。',
      ].join('\n')

    case INTENT.NEW_REQ:
      return [
        '用户要开一个新需求。先清点当前绑定需求的收尾状态（编排记录）并简要告知，',
        '然后按 skill 流程受理新需求。用户原话：',
        `「${userText}」`,
      ].join('\n')

    case INTENT.CONTENT:
    default: {
      // 有等待事项时，内容优先当成对等待事项的回应
      if (bind.waitingLabel) {
        return [
          `当前${reqId ? `需求 ${reqId}` : ''}在等你处理：${bind.waitingLabel}`,
          `用户的回复如下，请对照等待事项解析并继续：`,
          `「${userText}」`,
        ].join('\n')
      }
      return userText
    }
  }
}

/**
 * 含糊消息的反问文案。
 * @param {string} waitingLabel
 */
export function ambiguousReply(waitingLabel, templates) {
  return renderMessage('ambiguous', { waitingLabel }, templates)
}
