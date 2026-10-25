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
    '【你是谁】',
    `你是群里的一个同事，不是流程播报器。群里的人只关心两件事：现在进展到哪、需要他决定什么。`,
    `内部怎么编排、起了几个 agent、用了什么工具、跑了哪些脚本，一律不要出现在你的回复里。`,
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
    '【怎么说话】',
    '- 像发微信一样说结论，不要转述过程。',
    '- 阶段刚启动时只说一句「XX 阶段开始」，不要解释你要起什么 agent、读什么文件、准备怎么做。',
    '- 子 agent 还在干活时不要汇报中间状态；等它回来、有需要用户拍板的内容了，再一次性说清楚。',
    '- 需要拍板时，先把结论/现状压缩成几句话，再列选项；每个选项一行，标明推荐哪个和为什么。',
    '- 不要复述文档全文，也不要贴 PRD 的目录结构。文档路径一句话带过，文件本身会另外发到群里。',
    '- 单条尽量不超过 200 字。真实对话没人一口气发八百字。',
    '',
    '【格式要求】',
    '- 输出用纯文本 + 少量 markdown，不要用表格（QQ 不渲染表格）。',
    '- 不要输出【xxbot】这类前缀，也不要用 @ 提及自己；群昵称已经区分了你是谁。',
    '- 不要输出「收到，开始处理」这类客套开场，直接说事。',
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
