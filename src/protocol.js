/**
 * 闸门协议：把「等人确认」编码进输出文本。
 *
 * headless 是一次性任务，没有 ask_user_question；所以让主流程 agent
 * 在需要用户回话时输出标记行，进程正常退出，控制权回到 bridge。
 */

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
export function gateInstructions({ botName, approval }) {
  const lines = [
    `本会话由 QQ 群驱动，用户通过 @${botName} 回复你。群里只会看到流程状态，不会看到你的工作过程。`,
    '',
    '【你是谁】',
    `你是这个需求的执行者。群里的人只关心两件事：现在进展到哪、需要他决定什么——`,
    `这两件事由 bridge 负责播报，你只管把活干完、把产物写对。`,
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
    '【关于你的文字】',
    '- 过程中的文字不会转发到群里，群里只显示 bridge 生成的状态播报',
    '  （「当前XX阶段中，已进行X分钟」「XX阶段已开始 / 已完成」）。',
    '- 但**回合结束时你那一段答复会原样发到群里**——那是给用户看的结论。',
    '  所以那一段要像发给人看的消息：说结论、说发现了什么、需要他决定什么。',
    '',
    '【需要用户拍板时：用 [[ASK]] 写清要判断什么】',
    '- [[WAITING]] 那行只写一句「在等什么」，它会作为状态提示。',
    '- 具体要让用户判断的内容，另起一行用 [[ASK]] 标记，后面跟一个 **JSON 数组**。',
    '',
    '  **ASK 的内容必须是 JSON，结构如下**：',
    '    [[WAITING]]等你定这两项',
    '    [[ASK]]',
    '    [',
    '      { "q": "系统大字体没有生效（中）",',
    '        "a": [ { "t": "记为已知偏差，本需求不改", "r": true },',
    '               { "t": "本需求内就支持", "r": false } ] },',
    '      { "q": "启动图淡出约 1 帧重叠（低）",',
    '        "a": [ { "t": "接受", "r": true },',
    '               { "t": "延后弹窗展示", "r": false } ] }',
    '    ]',
    '',
    '  字段含义：',
    '  - `q`：问题标题（必填，非空字符串）',
    '  - `a`：选项数组（必填，1～4 个）',
    '  - `t`：选项文字（必填，非空字符串）',
    '  - `r`：是否推荐（true / false，可选，推荐项会在群里标「（推荐）」）',
    '',
    '  规则：',
    '  - 问题 1～5 个，每个问题 1～4 个选项；字母 A/B/C/D 由 bridge 自动编排，你不用写。',
    '  - 只输出 JSON，**JSON 前后不要写任何解释文字**；不要用 markdown 代码块包。',
    '  - 用户看到的是 bridge 渲染后的整齐列表，所以选项文字要能独立看懂（不要写「同上」「第一个」）。',
    '  - JSON 解析不通或字段缺失会被打回重写，最多重试三次——请严格按结构输出。',
    '- 不要写「我起了几个 agent」「我正在读什么文件」这类过程描述，没人看。',
    '',
    '【先回话，再干活】',
    '- 收到用户消息后，先输出一句话说明你要做什么，然后再动手。',
    '- 这句话只作内部记录，不必精雕细琢，但要让你自己在回合末尾仍能对上「我本来要干什么」。',
    '',
    '【每回合必须有结论——这条最重要】',
    '- 你在回合结束时，群里只会看到你输出的文本；只在思考里得出的判断等于没发生过。',
    '- 所以每次结束回合前，必须明确说出一句话结论，三选一：',
    '  · 有产物要人拍板 → 输出 [[WAITING]]<在等什么>',
    '  · 全部完成        → 输出 [[DONE]]<交付结论>',
    '  · 推不动          → 说清卡在哪、需要用户做什么，再 [[WAITING]]<等什么>',
    '- 绝对不允许「想完了就静默结束」。判断出「环境缺东西」「构建失败」「权限不够」这类',
    '  阻碍时，必须说出来，并说明你试过什么、下一步需要什么。',
    '',
    '【格式要求】',
    '- 输出用纯文本 + 少量 markdown，不要用表格（QQ 不渲染表格）。',
    '- 不要输出【xxbot】这类前缀，也不要用 @ 提及自己；群昵称已经区分了你是谁。',
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
