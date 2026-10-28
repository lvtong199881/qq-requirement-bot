/**
 * 编排执行器：把状态机的一个 checkpoint 变成一次 agent 回合。
 *
 * 三个职责，每个都刻意做成纯函数（除了读文件）：
 *   1. buildPrompt   组装任务包：角色卡 + 输入清单 + 硬约束 + 回执要求
 *   2. readReceipt   读 _receipt.json 并严格校验结构
 *   3. verifyOutputs 看产物清单，不信回执里声称写了什么
 *
 * 第 3 条是硬边界：agent 说「我写了」只是声明，产物在不在盘上由这里判。
 * 旧版把两者混在一起（解析文本 + 兜底转发），才出现「看起来正常但内容不对」的群消息。
 */
import { existsSync, readFileSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 回执文件名前缀。按阶段分文件存——所有阶段共用一个 _receipt.json 时，
 *  后一个阶段开局清理会把前一个阶段的回执删掉（dev 的 debug 包路径就这么丢过）。 */
export const RECEIPT_PREFIX = '_receipt'

/** 某个阶段自己的回执文件名 */
export function receiptFile(checkpointId) {
  return checkpointId ? `${RECEIPT_PREFIX}-${checkpointId}.json` : `${RECEIPT_PREFIX}.json`
}

/** 兼容旧引用：默认回执名（无阶段） */
export const RECEIPT_FILE = `${RECEIPT_PREFIX}.json`

/** 角色 → 群里和 prompt 里的称呼 */
export const ROLE_LABEL = {
  req: '需求 agent',
  design: '设计 agent',
  'tech-plan': '方案 agent',
  dev: '开发 agent',
  review: '评审 agent',
  test: '测试 agent',
  acceptance: '验收 agent',
}

/** 所有回合都注入的硬约束：从原 skill 的全局规则里提炼，属于编排层，不属于某个阶段 */
const HARD_RULES = [
  '不执行发布、删数据这类不可逆动作；commit / push 只在角色卡明确要求的阶段做（开发、合并），其余阶段一律不碰。',
  '只写本阶段产物，不改上游文档；发现上游有错，写进回执 blockers，不就地绕过。',
  '判断拿不准时写进回执的 decisions，不要自己拍板。',
  '不要起子 agent，不要并行开新会话。你这一回合就是全部。',
  '不要输出过程描述（「我正在读文件」这类）；正文只写结论，桥接层会把它投到群里。',
]

/**
 * 读某个角色的角色卡。
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
export function readSkill(skillsDir, role) {
  const file = join(skillsDir, role, 'SKILL.md')
  if (!existsSync(file)) return { ok: false, reason: `找不到角色卡：${file}` }
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (!text) return { ok: false, reason: `角色卡是空的：${file}` }
    return { ok: true, text }
  } catch (err) {
    return { ok: false, reason: `角色卡读取失败：${err.message}` }
  }
}

/** 把输入清单里的 <占位符> 换成真实值；没提供的原样留着，方便一眼看出缺什么 */
export function resolveInputs(inputs, vars) {
  return inputs.map((item) => item.replace(/<(\w+)>/g, (m, name) => vars?.[name] ?? m))
}

/**
 * 组装一次回合的 prompt。
 *
 * 结构：头部指明本回合只做哪一步 → 角色卡全文 → 输入白名单 → 硬约束 → 回执要求。
 * 回执放最后，因为长上下文里靠后的指令更容易被遵守。
 */
export function buildPrompt({ checkpoint, state, skillText, vars, roleLabel }) {
  const role = roleLabel ?? ROLE_LABEL[checkpoint.role] ?? checkpoint.role
  const inputs = resolveInputs(checkpoint.input, vars)

  const lines = [
    `${role}｜${state.reqId}`,
    '',
    `【本回合只做这一步】${checkpoint.label}（${checkpoint.id}）`,
    '',
    skillText,
    '',
    '---',
    '',
    '【输入】只读这些，不要读别的：',
    ...inputs.map((i) => `- ${i}`),
    '',
  ]

  // 用户回答单独成段（不和输入文件清单混在一起），由 varsFor 组织好
  if (vars?.answerBlock) {
    lines.push(vars.answerBlock, '')
  }

  // 产物位置必须写死。不写的话 agent 会自己去 docs/requirements/ 下挑一个目录——
  // 实测挑中了「最近改动的那个需求」，把新需求的产物写进了旧目录，
  // bridge 按 reqId 校验当然找不到，于是判定「没产出」开始返工。
  const outDir = vars?.reqDir ?? `docs/requirements/${state.reqId}/`
  const workDir = vars?.workDir ?? ''
  lines.push(
    '【产物位置】',
    // 文档和代码分属两个目录。不写清楚的话 agent 会把技术方案写进工作区、
    // 或者把代码改动留在文档目录，两种错都不会报错，直到合并时才发现一边缺东西。
    `- 文档（PRD / 设计说明 / 技术方案 / 各类报告）写到：${outDir}`,
    `- 本阶段文档产物：${(checkpoint.output ?? []).join('、') || '无文件产物，结论写进回执'}`,
    `- 回执 ${receiptFile(checkpoint.id)} 也写在这个目录`,
  )
  // 多仓库（组件化项目）：每个仓库一个独立工作区，都列出来
  const workspaces = vars?.workspaces ?? null
  if (workspaces && Object.keys(workspaces).length > 1) {
    lines.push('【各仓库工作区】这个需求涉及多个仓库，每个仓库一个工作区：')
    for (const [id, path] of Object.entries(workspaces)) {
      lines.push(`- ${id}：${path}`)
    }
    lines.push('代码改动写进对应的仓库工作区，别串仓。')
  }

  // 合并回次要拉开发工作区的分支过来：两个工作区都是独立仓库，只能靠路径互通
  const devWorkDir = vars?.devWorkDir ?? ''
  if (devWorkDir) {
    lines.push(`- 【开发工作区】要合并的分支在那里（用 git fetch <路径> feature/<需求标识> 拉过来）：${devWorkDir}`)
  }
  if (workDir) {
    lines.push(
      `- 代码（源码、单测、构建配置）改这里：${workDir}`,
      '- 不要把文档写进代码工作区，也不要把代码写进文档目录——合并时文档从文档目录归档、',
      '  代码从工作区合并，写错位置两边都会缺',
    )
  }
  lines.push(
    '- 不要写进别的需求目录，也不要读到别的需求里参考（需要参考历史需求时只读主仓库，不要写）',
    '',
  )

  // 设备由 bridge 分配，不让 agent 自己挑——多需求并行时它一挑就会撞上别人的设备
  if (checkpoint.needsDevice) {
    lines.push(
      '【本阶段分配给你的设备】',
      vars?.deviceId
        ? `- 设备 ID：${vars.deviceId}（平台：${vars?.platform ?? 'harmony'}）`
        : '- 没有分配到设备——这是异常情况，直接写回执报 blocked，不要自己去找设备',
      '- 只用这一台：所有装包、启动、截图、日志抓取都指向它。不要连别的设备，',
      '  也不要重启或重置它（别的需求可能正在用另一台，而你重启设备会影响你我之外的人）。',
      '',
    )
  }

  // 本机环境提示（DevEco 路径、构建要加 --no-daemon、已知状态这类）。
  // 以前写在 bot.config.json 的 envHints 里由 v1 注入，v2 漏了这段，
  // agent 会去猜工具链路径、重复验证已经完成的构建。
  if (vars?.envHints) {
    lines.push('【本机环境（已核实，不要再自己猜）】', vars.envHints, '')
  }

  lines.push(
    '【硬约束】',
    ...HARD_RULES.map((r) => `- ${r}`),
    '',
    '【回执——本回合必须产出】',
    `结束前把 ${receiptFile(checkpoint.id)} 写到需求目录（与产物同级），结构：`,
    '{',
    '  "status": "done | partial | blocked | needs_input",',
    '  "summary": "一句话说清这回合做了什么",',
    '  "artifacts": [{ "path": "相对项目根的路径", "action": "created | modified | deleted" }],',
    '  "selfCheck": "准出清单逐项结论；没跑就写「未验证」及原因",',
    '  "decisions": [{ "q": "要用户拍板的问题", "options": [{ "text": "选项", "recommended": true }] }],',
    '  "blockers": [{ "reason": "卡在哪、试过什么、需要什么", "severity": "blocker | suggestion" }],',
    '  "deliverables": { "debugPackage": "包路径#版本（仅开发阶段需要）" }',
    '}',
    '',
    'status 判定：做完 = done；只做了一部分 = partial；做不下去 = blocked；需要用户先回答 = needs_input。',
  )

  return lines.join('\n')
}

/**
 * 读回执并严格校验。返回 ok=false 时由调用方按「返工」处理，不要静默降级。
 */
export function readReceipt(reqDir, checkpointId) {
  const name = receiptFile(checkpointId)
  const file = join(reqDir, name)
  if (!existsSync(file)) return { ok: false, reason: `没有写 ${name}` }

  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { ok: false, reason: `回执 JSON 解析失败：${err.message}` }
  }

  const invalid = validateReceipt(data)
  if (invalid) return { ok: false, reason: invalid }
  return { ok: true, receipt: data }
}

/** 回执结构校验，返回第一条问题；全部合规返回 null */
export function validateReceipt(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '回执最外层必须是对象'
  const STATUS = ['done', 'partial', 'blocked', 'needs_input']
  if (!STATUS.includes(data.status)) return `status 必须是 ${STATUS.join(' / ')}，收到 ${JSON.stringify(data.status)}`
  if (data.artifacts !== undefined && !Array.isArray(data.artifacts)) return 'artifacts 必须是数组'
  for (const [i, a] of (data.artifacts ?? []).entries()) {
    if (!a || typeof a.path !== 'string' || !a.path.trim()) return `artifacts[${i}] 缺少 path`
  }
  if (data.decisions !== undefined && !Array.isArray(data.decisions)) return 'decisions 必须是数组'
  for (const [i, d] of (data.decisions ?? []).entries()) {
    if (!d || typeof d.q !== 'string' || !d.q.trim()) return `decisions[${i}] 缺少 q`
  }
  if (data.blockers !== undefined && !Array.isArray(data.blockers)) return 'blockers 必须是数组'
  return null
}

/** 回合开始前清掉上一轮的回执，避免读到旧结果当成这一轮的 */
export function clearReceipt(reqDir, checkpointId) {
  try {
    unlinkSync(join(reqDir, receiptFile(checkpointId)))
  } catch {
    /* 不存在就算了，正常情况 */
  }
}

/**
 * 校验产物。
 *
 * 两种模式：
 *   files   按 checkpoint.output 逐个核对存在且非空（默认）
 *   gitDiff 开发类阶段，看有没有代码改动——源码文件没法按名字列
 *
 * @returns {{ok: boolean, missing: string[], reason?: string}}
 */
export function verifyOutputs({ checkpoint, reqDir, gitDiff }) {
  if (checkpoint.verify === 'gitDiff') {
    const has = Boolean(gitDiff?.trim())
    return has ? { ok: true, missing: [] } : { ok: false, missing: [], reason: '没有检测到代码改动（git diff 为空）' }
  }

  const missing = []
  for (const item of checkpoint.output ?? []) {
    const full = join(reqDir, item)
    if (item.endsWith('/')) {
      // 目录：存在且非空。设计稿是批量文件，不能只看目录在不在
      if (!existsSync(full) || !readdirSync(full).length) missing.push(item)
    } else {
      if (!existsSync(full) || statSync(full).size === 0) missing.push(item)
    }
  }

  if (missing.length) {
    return { ok: false, missing, reason: `缺少产物：${missing.join('、')}` }
  }
  return { ok: true, missing: [] }
}
