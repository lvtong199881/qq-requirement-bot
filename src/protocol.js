/**
 * 闸门协议：把「等人确认」编码进输出文本。
 *
 * headless 是一次性任务，没有 ask_user_question；所以让主流程 agent
 * 在需要用户回话时输出标记行，进程正常退出，控制权回到 bridge。
 */

import { gateInstructions } from './prompt.js'

export { gateInstructions }

const WAITING_RE = /\[\[\s*WAITING\s*\]\]/i
/**
 * [[ASK]]<需要用户确认的具体内容>
 * 到下一个 [[ 标记或文本结尾为止，可以多行。
 * 这是 WAITING 的补充：WAITING 说「在等什么」，ASK 说「具体要判断什么」。
 */
const ASK_RE = /\[\[\s*ASK\s*\]\]([\s\S]*?)(?=\[\[|$)/i
const DONE_RE = /\[\[\s*DONE\s*\]\]/i

/** 单行标记，允许 [] 内换不同写法：[[WAITING]] 阶段3 技术方案 */
const MARKER_LINE_RE = /^[\s>*_`-]*\[\[\s*(WAITING|DONE)\s*\]\][\s:：\-—]*([^\n]*)$/gim

/**
 * 解析 agent 输出里的标记。
 * @param {string} text
 * @returns {{state: 'waiting'|'done'|'running', label: string, cleaned: string}}
 */
export function parseGate(text) {
  let raw = text ?? ''
  let state = 'running'
  let label = ''
  let ask = ''

  // 先把 ASK 段摘出来——它可能包含多行，不参与标记行扫描
  const askMatch = raw.match(ASK_RE)
  if (askMatch) {
    ask = stripDecorations(askMatch[1]).trim()
    raw = raw.replace(askMatch[0], '').trim()
  }

  let m
  const lines = []
  MARKER_LINE_RE.lastIndex = 0
  while ((m = MARKER_LINE_RE.exec(raw)) !== null) {
    const kind = m[1].toUpperCase()
    const tail = (m[2] || '').trim()
    if (kind === 'WAITING') {
      state = 'waiting'
      label = tail
    } else if (state !== 'waiting') {
      state = 'done'
      label = tail
    }
    lines.push(m[0])
  }

  const cleaned = lines.reduce((acc, line) => acc.split(line).join(''), raw).trim()

  // 兼容 **[[DONE]]** 这类包裹：去掉标记行残留的 markdown 符号
  label = label.replace(/^[*_`\s]+/, '').replace(/[*_`\s]+$/, '')

  return { state, label, ask, cleaned }
}

/** 去掉标记残留的 markdown 包裹符号 */
function stripDecorations(text) {
  return (text ?? '')
    .replace(/^[*_`\s]+/, '')
    .replace(/[*_`\s]+$/, '')
    .replace(/^[-—]{2,}\s*/gm, '')
}

/** 给 agent 的任务前缀：定义它在群里如何提问和停下 */
