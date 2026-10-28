/**
 * 流程定义与状态机 —— 桥接层唯一的「流程知识」。
 *
 * 为什么写死在这里、而不是让 agent 读 skill 决定下一步：
 * skill 是「某个角色怎么干活」的能力包，它不该知道流程走到哪一步；
 * bridge 是唯一的编排者，阶段顺序、输入输出、投递物都是编排知识。
 * 写死之后状态只有一个真相源，不需要反解析任何文档或文本标记——
 * 这正是旧版（解析 [[WAITING]]、编排记录表格、意图正则）反复出错的根因。
 *
 * 这个模块刻意保持纯函数：不碰 fs、不发消息、不 spawn 进程。
 * 产物校验由调用方做完把结果传进来，这样状态机可以单测，
 * 不需要 mock LLM，也不需要真跑一个群。
 */

/** 返工上限：同一 checkpoint 连续三轮不达标就停，等用户决策 */
export const MAX_RETRY = 3

/**
 * 阶段清单。顺序即主链；`next` 以 @ 开头表示分支节点，由 GATES 判定。
 *
 * input 里的 <...> 是运行时占位符，由 orchestrator 替换成真实路径：
 *   <userRequest>   用户原始需求原文
 *   <userAnswer>    用户对上一次提问的回答
 *   <projectTree>   项目目录结构
 *   <changedFiles>  本轮改动文件清单
 *   <diff>          本轮 git diff
 *   <debugPackage>  开发阶段产出的 debug 包路径与版本
 *   <screenshots>   docs/ui-screenshots/ 下相关页面截图
 *   <testAccount>   测试账号与数据
 * output 是校验依据：校验看它，不看 agent 回执里声称写了什么。
 * deliverable 是投到群里的那一份，null 表示只发回执 summary（开发阶段就是这样）。
 */
export const CHECKPOINTS = [
  {
    id: 'req-questions',
    role: 'req',
    label: '需求澄清',
    input: ['<userRequest>', 'AGENTS.md', '<projectTree>', '<screenshots>'],
    output: ['待提问清单.md'],
    deliverable: '待提问清单.md',
    next: 'req-prd',
    // 产出后必须等用户回答：疑点清单是给人答的，不能自己往下走
    waitUser: true,
  },
  {
    id: 'req-prd',
    role: 'req',
    label: '需求定稿',
    // 用户回答不放在「输入文件清单」里——那是文件列表，混进去 agent 会当成文件名去猜。
    // 改由 vars.answerBlock 单独成段，见 orchestrator.buildPrompt。
    input: ['待提问清单.md', 'AGENTS.md'],
    output: ['需求卡片.md', 'PRD.md'],
    deliverable: 'PRD.md',
    next: 'design',
  },
  {
    id: 'design',
    role: 'design',
    label: '设计',
    input: ['PRD.md', '需求卡片.md', '<screenshots>'],
    output: ['设计说明.md', 'figma-import/', 'design-images/'],
    deliverable: 'figma-import/',
    // 效果图单独发：zip 用户得下载解压才能看，图直接进群一眼就能看
    images: 'design-images/',
    next: 'tech-plan',
  },
  {
    id: 'tech-plan',
    role: 'tech-plan',
    label: '技术方案',
    input: ['PRD.md', '需求卡片.md', '设计说明.md'],
    output: ['技术方案.md'],
    deliverable: '技术方案.md',
    next: 'dev',
  },
  {
    id: 'dev',
    role: 'dev',
    label: '开发',
    input: ['技术方案.md', '设计说明.md', 'PRD.md', 'AGENTS.md', '<projectTree>'],
    output: ['技术方案.md'],
    // 开发阶段的真实产出是源码，没法按文件名逐个核对；
    // 改成看 git diff 有没有东西，比「声称写了哪些文件」可靠。
    // 注意：这个 checkpoint 开始前 bridge 会先切到 feature/<reqId> 分支。
    verify: 'gitDiff',
    // 要往设备上装包跑，占用独占设备资源
    needsDevice: true,
    deliverable: null,
    next: 'review',
  },
  {
    id: 'review',
    role: 'review',
    label: '代码评审',
    input: ['技术方案.md', '<changedFiles>', '<diff>', 'AGENTS.md'],
    output: ['代码评审报告.md'],
    deliverable: '代码评审报告.md',
    next: '@reviewGate',
  },
  {
    id: 'fix',
    role: 'dev',
    label: '评审修正',
    // 复用开发 agent 的会话，所以 input 只要评审报告和 diff
    input: ['代码评审报告.md', '<diff>'],
    output: ['技术方案.md'],
    verify: 'gitDiff',
    deliverable: null,
    next: 're-review',
  },
  {
    id: 're-review',
    role: 'review',
    label: '评审复审',
    // 复审复用评审 agent 的会话，只回答本轮要闭环的问题编号
    input: ['代码评审报告.md', '<diff>'],
    output: ['代码评审报告.md'],
    deliverable: null,
    next: '@reviewGate',
  },
  {
    id: 'test',
    role: 'test',
    label: '测试',
    input: ['PRD.md', '技术方案.md', '<debugPackage>', '<testAccount>'],
    output: ['测试报告.md'],
    deliverable: '测试报告.md',
    needsDevice: true,
    next: 'acceptance',
  },
  {
    id: 'acceptance',
    role: 'acceptance',
    label: '验收',
    input: ['PRD.md', '需求卡片.md', '设计说明.md', 'figma-import/', '<screenshots>', '<debugPackage>'],
    output: ['验收文档.md'],
    deliverable: '验收文档.md',
    needsDevice: true,
    next: 'merge',
  },
  {
    id: 'merge',
    // 合并由 bridge 执行：要跨两个工作区操作（开发工作区 fetch 到合并工作区），
    // 这是桥的职责，agent 只在自己工作区里。
    role: null,
    label: '合并',
    input: ['技术方案.md', '<mergeInfo>'],
    output: [],
    // 合并本身不产生新文件，靠回执里的编译/测试结论说明结果
    verify: 'none',
    deliverable: null,
    next: 'wrapup',
    // 不单独确认：用户「通过」验收就等于同意合并。
    // 合并不跑编译——编译验证在开发阶段已经做过，合并只是搬运已验证的提交，
    // 而合并是全局串行的，跑一次编译会挡住其他需求。
  },
  {
    id: 'wrapup',
    role: null, // bridge 终检，不派 agent
    label: '收尾',
    input: [],
    output: [],
    deliverable: null,
    next: null,
  },
]

/** 主链首尾，给「从哪个阶段开始」「什么时候算全跑完」用 */
export const FIRST_CHECKPOINT = CHECKPOINTS[0].id
export const LAST_CHECKPOINT = CHECKPOINTS[CHECKPOINTS.length - 1].id

const BY_ID = new Map(CHECKPOINTS.map((c) => [c.id, c]))

export function getCheckpoint(id) {
  return BY_ID.get(id) ?? null
}

/** 角色 → 该角色服务过哪些 checkpoint（用来判断 session 该不该复用） */
export function checkpointsOfRole(role) {
  return CHECKPOINTS.filter((c) => c.role === role).map((c) => c.id)
}

/**
 * 分支节点。输入校验结果和回执，输出下一个 checkpoint id。
 *
 * 评审这道闸门由 bridge 判，不由 agent 判——agent 只报告「有哪些问题」，
 * 「这些问题够不够拦下流程」是编排决策。
 */
export const GATES = {
  /**
   * 评审闸门：有未闭环的阻断/应修项就回开发修，没有才放行到测试。
   *
   * 判定依据是回执的 blockers，不是评审报告的行文——报告是给人看的，
   * 回执才是机器读的。这条边界守不住，又会退化成解析自然语言。
   */
  reviewGate(state, receipt) {
    const blocking = (receipt?.blockers ?? []).filter((b) => b?.severity !== 'suggestion')
    if (blocking.length) {
      // 已经修过 MAX_RETRY 轮还在卡，就不再自动循环，交用户决策
      const rounds = state.rounds?.fix ?? 0
      if (rounds >= MAX_RETRY) return { next: null, stop: 'retryExhausted', reason: `评审返工 ${rounds} 轮仍有 ${blocking.length} 项未闭环` }
      return { next: 'fix' }
    }
    return { next: 'test' }
  },
}

/**
 * 新建需求时的初始状态。
 * rounds 记录每个 checkpoint 的返工轮次，落盘保存，跨进程重启不归零。
 */
/**
 * @param {object} o
 * @param {string} o.reqId      随机标识，与名称无关
 * @param {string} [o.name]     给人看的名字（需求原文截断），只用于展示
 * @param {string} o.projectDir 主仓库路径（裸仓库的宿主目录，用于兼容与 git 操作）
 * @param {string} [o.dataDir]  需求文档目录（不进 git）；空表示还没分配
 * @param {string} [o.workDir]  代码工作区（dev 起才有）；空表示还没创建
 * @param {string} [o.repoDir]  裸仓库路径
 */
export function initialState({ reqId, name = '', projectDir, dataDir = null, workDir = null, repoDir = null }) {
  return {
    reqId,
    name,
    projectDir,
    // 文档与代码分属两个目录：文档从头到尾写在 dataDir，代码只在 dev~merge 存在于 workDir
    dataDir,
    workDir,
    repoDir,
    current: FIRST_CHECKPOINT,
    rounds: {},
    status: 'running', // running | waiting_user | blocked | done
    waiting: null, // { checkpointId, decisions } 等用户回答时填
    history: [], // 每回合一条，给面板和排错用
  }
}

/** 当前 checkpoint；跑完返回 null */
export function currentCheckpoint(state) {
  return state.current ? getCheckpoint(state.current) : null
}

/**
 * 该 checkpoint 是否需要派 agent 回合。
 * commit / wrapup 是 bridge 自己的动作，不消耗模型额度。
 */
export function needsAgent(checkpoint) {
  return Boolean(checkpoint?.role)
}

/**
 * 推进状态机。
 *
 * @param {object} state 当前状态（不会被修改）
 * @param {object|null} receipt agent 回执，bridge 自己执行的 checkpoint 传 null
 * @param {{ok: boolean, missing?: string[], reason?: string}} [verify] 产物校验结果
 * @returns {{action: string, state: object, reason?: string, checkpoint?: object}}
 *   action:
 *     continue   进入下一 checkpoint
 *     wait_user  等用户回答（waiting 里带 questions）
 *     retry      同一 checkpoint 返工
 *     blocked    停下等用户决策
 *     done       全流程结束
 *     bridge     bridge 自己执行（commit / wrapup），不派 agent
 */
export function advance(state, receipt, verify = { ok: true }, opts = {}) {
  const cp = currentCheckpoint(state)
  if (!cp) return { action: 'done', state: { ...state, status: 'done' }, reason: '流程已结束' }

  const nextState = {
    ...state,
    rounds: { ...state.rounds },
    history: [...state.history],
  }

  // ── bridge 自己的动作：commit / wrapup ──
  // 这些动作是同步完成的，所以状态直接推进到下一个 checkpoint；
  // bridge 拿到 action=bridge 后执行动作，用返回的 state 继续。
  if (!needsAgent(cp)) {
    // commit 这种「bridge 执行但要用户点头」的步骤：停在原地，
    // 推进藏在 advanceTo 里，用户确认后 resumeFromUser 接上。
    if (cp.waitUser) {
      nextState.status = 'waiting_user'
      // bridge: true 让 announceStop 知道「bridgeAction 已经说清楚了」，不用再补话
      nextState.waiting = { checkpointId: cp.id, decisions: [], advanceTo: cp.next, bridge: true }
      return { action: 'wait_user', state: nextState, checkpoint: cp, reason: null }
    }
    nextState.current = cp.next
    if (!cp.next) {
      nextState.status = 'done'
      nextState.waiting = null
      return { action: 'bridge', state: nextState, checkpoint: cp, reason: null }
    }
    return { action: 'bridge', state: nextState, checkpoint: cp, reason: null }
  }

  // ── agent 报告需要用户输入：停在这里，把问题带出去 ──
  if (receipt?.status === 'needs_input') {
    nextState.status = 'waiting_user'
    nextState.waiting = {
      checkpointId: cp.id,
      decisions: receipt.decisions ?? [],
      // 这个 checkpoint 本来就要求「产出后等用户回答」（需求澄清），
      // 那么回答完应该推进到下一站，而不是原地重跑一遍澄清。
      // 少了这一行，用户回答完会一直卡在需求澄清——实测踩到过。
      ...(cp.waitUser && cp.next ? { advanceTo: cp.next } : {}),
    }
    return { action: 'wait_user', state: nextState, checkpoint: cp, reason: null }
  }

  // ── agent 报阻塞：不再自动重试，交用户 ──
  if (receipt?.status === 'blocked') {
    nextState.status = 'blocked'
    nextState.waiting = {
      checkpointId: cp.id,
      decisions: [],
      blockers: receipt.blockers ?? [],
      reason: (receipt.blockers ?? []).map((b) => b?.reason ?? b).filter(Boolean).join('；') || null,
    }
    return {
      action: 'blocked',
      state: nextState,
      checkpoint: cp,
      reason: (receipt.blockers ?? []).map((b) => b?.reason ?? b).join('；') || 'agent 报告阻塞',
    }
  }

  // ── 产物校验不通过，或者 agent 自报 partial：返工同一 checkpoint ──
  const incomplete = receipt?.status === 'partial' || !verify.ok
  if (incomplete) {
    const round = (nextState.rounds[cp.id] ?? 0) + 1
    if (round > MAX_RETRY) {
      nextState.status = 'blocked'
      nextState.waiting = {
        checkpointId: cp.id,
        decisions: [],
        reason: `「${cp.label}」连续 ${MAX_RETRY} 轮不达标：${verify.reason ?? receipt?.summary ?? '产物缺失'}`,
      }
      return {
        action: 'blocked',
        state: nextState,
        checkpoint: cp,
        reason: `「${cp.label}」连续 ${MAX_RETRY} 轮不达标：${verify.reason ?? receipt?.summary ?? '产物缺失'}`,
      }
    }
    nextState.rounds[cp.id] = round
    return {
      action: 'retry',
      state: nextState,
      checkpoint: cp,
      reason: verify.reason ?? missingReason(verify.missing),
    }
  }

  // ── 通过：解析 next，分支节点走 GATES ──
  let nextId = cp.next
  if (typeof nextId === 'string' && nextId.startsWith('@')) {
    const gate = GATES[nextId.slice(1)]
    if (!gate) throw new Error(`未定义的分支节点：${nextId}`)
    const decided = gate(nextState, receipt)
    if (!decided.next) {
      nextState.status = 'blocked'
      nextState.waiting = { checkpointId: cp.id, decisions: [], reason: decided.reason }
      return { action: 'blocked', state: nextState, checkpoint: cp, reason: decided.reason }
    }
    nextId = decided.next
  }

  // 评审闸门放行到 fix 时，返工计数按「修了几轮」算
  if (nextId === 'fix') {
    nextState.rounds.fix = (nextState.rounds.fix ?? 0) + 1
  }

  // 产出后要等用户回答的 checkpoint（需求澄清）：停在原地，不推进 current。
  // 推进藏在 waiting.advanceTo 里，等用户回答后由 resumeFromUser 解开。
  // 先设 current 再判断的话，状态会「看起来已经到了下一阶段」，面板和播报都会错。
  if (cp.waitUser) {
    nextState.status = 'waiting_user'
    nextState.waiting = { checkpointId: cp.id, decisions: receipt?.decisions ?? [], advanceTo: nextId }
    return { action: 'wait_user', state: nextState, checkpoint: cp, reason: null }
  }

  // 手动批准模式：每个派 agent 的阶段的产物都要人看过再往下走。
  // 不加这段，approval=manual 形同虚设——实测 PRD 刚写完就直接进了设计，
  // 再往下就是开发改源码，没有人按住它。
  if (opts.requireApproval && cp.role && !cp.waitUser && cp.id !== 'merge') {
    nextState.status = 'waiting_user'
    // agent 在这一阶段问的疑点不能因为「等确认」就丢掉，一起带给用户
    nextState.waiting = {
      checkpointId: cp.id,
      decisions: receipt?.decisions ?? [],
      advanceTo: nextId,
      approve: true,
    }
    return { action: 'wait_user', state: nextState, checkpoint: cp, reason: null }
  }

  nextState.current = nextId
  nextState.status = 'running'
  nextState.waiting = null

  return { action: 'continue', state: nextState, checkpoint: getCheckpoint(nextId) }
}

/**
 * 用户回答完之后继续。
 *
 * 两种等待都要处理：
 *   · 需求澄清那种「产出后停住」——waiting.advanceTo 有值，解冻后推进到下一阶段
 *   · agent 主动 needs_input 那种——没有 advanceTo，重新执行同一个 checkpoint
 * 只处理第一种的话，第二种会永远卡在 waiting_user，这是典型的一条分支忘了写。
 */
export function resumeFromUser(state) {
  if (state.status !== 'waiting_user') return state
  const next = { ...state, status: 'running', waiting: null }
  if (state.waiting?.advanceTo) next.current = state.waiting.advanceTo
  return next
}

/** 可读的缺口描述 */
function missingReason(missing) {
  return missing?.length ? `缺少产物：${missing.join('、')}` : '产物校验未通过'
}
