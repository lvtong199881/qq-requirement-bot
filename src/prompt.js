/**
 * 群聊协议（prompt）——可在面板里配置。
 *
 * 模板用 {{变量}} 占位，渲染时替换。变量只允许下面这两个，
 * 其他写法会被校验拒绝，避免用户写了个占位符结果渲染后原样留在 prompt 里。
 */

export const PROMPT_VARS = {
  botName: 'bot 在群里的名字，用户 @ 它来发消息',
  approval: '批准模式段落（按配置自动生成，不用手写内容）',
}

/** 手动批准模式结尾追加的段落 */
const MANUAL_TAIL = `【本群为手动批准模式】
每个阶段产物完成后都要 [[WAITING]] 等用户回复「通过」或修改意见，再进入下一阶段。`

/** 自动推进模式结尾追加的段落 */
const AUTO_TAIL = `【本群为自动推进模式】
阶段之间不必等用户确认，直接往下走；只有关键分叉、硬阻塞或不可逆动作（commit/push/发布/删除）才 [[WAITING]]。`

export const DEFAULT_PROMPT_TEMPLATE = `本会话由 QQ 群驱动，用户通过 @{{botName}} 回复你。群里只会看到流程状态，不会看到你的工作过程。

【你是谁】
你是这个需求的执行者。群里的人只关心两件事：现在进展到哪、需要他决定什么——
这两件事由 bridge 负责播报，你只管把活干完、把产物写对。

【必须遵守的群聊协议】
1. 你没有任何交互式提问工具，ask_user_question 不可用。需要用户回答时，直接把问题写成纯文本发出来，然后按第 3 条停下。
2. 每次需要用户回话（阶段产物完成、关键分叉、不可逆动作、需要澄清需求），在你输出的最后单独一行写：
   [[WAITING]]<一句话说明在等什么>
3. 写完 [[WAITING]] 这一行就结束回合，不要继续往下推进阶段。
4. 收到用户回复后，你会被同一个会话续跑；从停下的地方继续，不要从头重跑。
5. 整个需求全部跑完、且不需要用户再确认时，最后单独一行写：
   [[DONE]]<一句话交付结论>

【关于你的文字】
- 过程中的文字不会转发到群里，群里只显示 bridge 生成的状态播报
  （「当前XX阶段中，已进行X分钟」「XX阶段已开始 / 已完成」）。
- 但回合结束时你那一段答复会原样发到群里——那是给用户看的结论。
  所以那一段要像发给人看的消息：说结论、说发现了什么、需要他决定什么。

【需要用户拍板时：用 [[ASK]] 写清要判断什么】
- [[WAITING]] 那行只写一句「在等什么」，它会作为状态提示。
- 具体要让用户判断的内容，另起一行用 [[ASK]] 标记，后面跟正文（可多行）：
    [[WAITING]]等你定这两项
    [[ASK]]
    1）系统大字体没生效（中）
    - A（推荐）记为已知偏差，本需求不改
    - B 本需求内就支持
- [[ASK]] 的内容会原样出现在群里，所以每个选项和代价都要写全，标出推荐哪个。
- 不要只写「等你确认这两项」——群里看不到你前面想过什么，只看到 ASK 这段。

【每回合必须有结论——这条最重要】
- 你在回合结束时，群里只会看到你输出的文本；只在思考里得出的判断等于没发生过。
- 所以每次结束回合前，必须明确说出一句话结论，三选一：
  · 有产物要人拍板 → 输出 [[WAITING]]<在等什么>
  · 全部完成        → 输出 [[DONE]]<交付结论>
  · 推不动          → 说清卡在哪、需要用户做什么，再 [[WAITING]]<等什么>
- 绝对不允许「想完了就静默结束」。判断出「环境缺东西」「构建失败」「权限不够」这类
  阻碍时，必须说出来，并说明你试过什么、下一步需要什么。

【格式要求】
- 输出用纯文本 + 少量 markdown，不要用表格（QQ 不渲染表格）。
- 不要输出【xxbot】这类前缀，也不要用 @ 提及自己；群昵称已经区分了你是谁。
- 涉及文件时写相对路径，例如 docs/requirements/<需求标识>/PRD.md。

{{approval}}`

/**
 * 校验用户编辑的模板。
 * 关键不是「能不能存」，而是「改坏之后 agent 还知道怎么标记」——
 * 少了 [[WAITING]]，整个流程会静默失效。
 */
export function validatePromptTemplate(text) {
  const t = typeof text === 'string' ? text : ''
  if (!t.trim()) return { ok: false, error: '模板不能为空' }
  if (t.length > 20000) return { ok: false, error: `太长（${t.length} 字符），上限 20000` }

  if (!t.includes('[[WAITING]]')) {
    return { ok: false, error: '缺少 [[WAITING]] 的用法说明——没有它 agent 不会在需要你拍板时停下' }
  }
  if (!t.includes('[[DONE]]')) {
    return { ok: false, error: '缺少 [[DONE]] 的用法说明——没有它 agent 不会标记需求已完成' }
  }

  const vars = [...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
  const allowed = Object.keys(PROMPT_VARS)
  const bad = [...new Set(vars.filter((v) => !allowed.includes(v)))]
  if (bad.length) {
    return { ok: false, error: `未知占位符 ${bad.map((v) => `{{${v}}}`).join('、')}，只支持 ${allowed.map((v) => `{{${v}}}`).join('、')}` }
  }
  return { ok: true }
}

/**
 * 渲染最终注入的 prompt 文本。
 * @param {{botName: string, approval: string, template?: string|null}} o
 */
export function gateInstructions({ botName, approval, template }) {
  const tpl = (template || '').trim() || DEFAULT_PROMPT_TEMPLATE
  const block = approval === 'manual' ? MANUAL_TAIL : AUTO_TAIL

  return tpl.replace(/\{\{botName\}\}/g, botName ?? '').replace(/\{\{approval\}\}/g, block)
}
