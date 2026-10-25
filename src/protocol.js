/**
 * 闸门协议：把「等人确认」编码进输出文本。
 *
 * headless 是一次性任务，没有 ask_user_question；所以让主流程 agent
 * 在需要用户回话时输出标记行，进程正常退出，控制权回到 bridge。
 */

const WAITING_RE = /\[\[\s*WAITING\s*\]\]/i
const DONE_RE = /\[\[\s*DONE\s*\]\]/i

/** 单行标记，允许 [] 内换不同写法：[[WAITING]] 阶段3 技术方案 */
const MARKER_LINE_RE = /^[\s>*_`-]*\[\[\s*(WAITING|DONE)\s*\]\][\s:：\-—]*([^\n]*)$/gim

/**
 * 解析 agent 输出里的标记。
 * @param {string} text
 * @returns {{state: 'waiting'|'done'|'running', label: string, cleaned: string}}
 */
export function parseGate(text) {
  const raw = text ?? ''
  let state = 'running'
  let label = ''

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

  return { state, label, cleaned }
}

/** 给 agent 的任务前缀：定义它在群里如何提问和停下 */
export function gateInstructions({ botName, approval }) {
  const lines = [
    `本会话由 QQ 群驱动，用户通过 @${botName} 回复你。你的输出会被直接转发到群里。`,
    '',
    '【必须遵守的群聊协议】',
    `1. 你没有任何交互式提问工具，ask_user_question 不可用。需要用户回答时，直接把问题写成纯文本发出来，然后按第 3 条停下。`,
    `2. 每次需要用户回话（阶段产物完成、关键分叉、不可逆动作、需要澄清需求），在你输出的最后单独一行写：`,
    `   [[WAITING]]<一句话说明在等什么>`,
    `3. 写完 [[WAITING]] 这一行就结束回合，不要继续往下推进阶段。`,
    `4. 收到用户回复后，你会被同一个会话续跑；从停下的地方继续，不要从头重跑。`,
    `5. 整个需求全部跑完、且不需要用户再确认时，最后单独一行写：`,
    `   [[DONE]]<一句话交付结论>`,
    '',
    '【格式要求】',
    '- 输出用纯文本 + 少量 markdown，不要用表格（QQ 不渲染表格）。',
    '- 不要输出【xxbot】这类前缀，群昵称已经区分了你是谁。',
    '- 阶段进度用短句汇报，单条不超过 300 字；长内容会被拆成多条推送。',
    '- 涉及文件时写相对路径，例如 docs/requirements/<需求标识>/PRD.md。',
    '',
  ]

  if (approval === 'manual') {
    lines.push(
      '【本群为手动批准模式】',
      '每个阶段产物完成后都要 [[WAITING]] 等用户回复「通过」或修改意见，再进入下一阶段。',
      '',
    )
  } else {
    lines.push(
      '【本群为自动推进模式】',
      '阶段之间不必等用户确认，直接往下走；只有关键分叉、硬阻塞或不可逆动作（commit/push/发布/删除）才 [[WAITING]]。',
      '',
    )
  }

  return lines.join('\n')
}
