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
 * 阶段清单。顺序只是书写习惯，真正的走向由 EDGES 决定；
 * id 是状态机与 worktree/设备等外部资源绑定的键，不可改动。
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
  },
  {
    id: 'design',
    role: 'design',
    label: '设计',
    input: ['PRD.md', '需求卡片.md', '<screenshots>'],
    output: ['设计说明.md', 'design/', 'design-images/'],
    deliverable: 'design/',
    // 效果图单独发：zip 用户得下载解压才能看，图直接进群一眼就能看
    images: 'design-images/',
  },
  {
    id: 'tech-plan',
    role: 'tech-plan',
    label: '技术方案',
    input: ['PRD.md', '需求卡片.md', '设计说明.md'],
    output: ['技术方案.md'],
    deliverable: '技术方案.md',
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
  },
  {
    id: 'review',
    role: 'review',
    label: '代码评审',
    input: ['技术方案.md', '<changedFiles>', '<diff>', 'AGENTS.md'],
    output: ['代码评审报告.md'],
    deliverable: '代码评审报告.md',
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
  },
  {
    id: 're-review',
    role: 'review',
    label: '评审复审',
    // 复审复用评审 agent 的会话，只回答本轮要闭环的问题编号
    input: ['代码评审报告.md', '<diff>'],
    output: ['代码评审报告.md'],
    deliverable: null,
  },
  {
    id: 'test',
    role: 'test',
    label: '测试',
    input: ['PRD.md', '技术方案.md', '<debugPackage>', '<testAccount>'],
    output: ['测试报告.md'],
    deliverable: '测试报告.md',
    needsDevice: true,
  },
  {
    id: 'acceptance',
    role: 'acceptance',
    label: '验收',
    input: ['PRD.md', '需求卡片.md', '设计说明.md', 'design/', '<screenshots>', '<debugPackage>'],
    output: ['验收文档.md'],
    deliverable: '验收文档.md',
    needsDevice: true,
  },
  {
    id: 'merge',
    // 合并交回 agent：合并失败（冲突、依赖版本对不上）要有人解决，停下等人
    // 是最差的结果。agent 在合并工作区里能自由操作 git，冲突它自己看、自己解。
    role: 'dev',
    label: '合并',
    input: ['技术方案.md', '<mergeInfo>'],
    output: [],
    // 合并本身不产生新文件，靠回执里的编译/测试结论说明结果
    verify: 'none',
    deliverable: null,
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
  },
]

/**
 * 边表——流程的真正拓扑。advance 对当前节点的出边按声明顺序求值守卫，
 * 第一条命中的决定去向；一条都不命中就 blocked（兜底，防死图）。
 *
 * when 的取值见 GUARDS：
 *   auto          无条件放行（评审链这种产出互为输入的直通段）
 *   waitUser      产出后必须等用户回答（需求澄清：疑点清单是给人答的）
 *   approve       手动批准模式下停等确认（确认卡「本轮是否通过？」）
 *   approveForce  无论什么模式都必须人拍板（合并进主分支）
 *   hasBlockers   评审闸门：有未闭环的阻断/应修项
 *   noBlockers    评审闸门：全闭环放行
 *   retry         自环：产物不达标时返工本节点（maxRounds 封顶）
 *
 * 改动这里之后跑 `node src/flow/graph.js --validate`，
 * 它会检查不可达节点、无出边节点、retry 环封顶这些结构性错误。
 */
export const EDGES = [
  { from: 'req-questions', to: 'req-prd', when: 'waitUser' },
  { from: 'req-prd', to: 'design', when: 'approve' },
  { from: 'design', to: 'tech-plan', when: 'approve' },
  { from: 'tech-plan', to: 'dev', when: 'approve' },
  { from: 'dev', to: 'review', when: 'auto' },
  { from: 'review', to: 'fix', when: 'hasBlockers' },
  { from: 'review', to: 'test', when: 'noBlockers' },
  { from: 'fix', to: 're-review', when: 'auto' },
  { from: 're-review', to: 'fix', when: 'hasBlockers' },
  { from: 're-review', to: 'test', when: 'noBlockers' },
  { from: 'test', to: 'acceptance', when: 'approve' },
  { from: 'acceptance', to: 'merge', when: 'approve' },
  { from: 'merge', to: 'wrapup', when: 'approveForce' },
]

const BY_ID = new Map(CHECKPOINTS.map((c) => [c.id, c]))

export function getCheckpoint(id) {
  return BY_ID.get(id) ?? null
}

/** 节点的出边（按声明顺序），advance 逐条求值守卫 */
export function edgesOf(id) {
  return EDGES.filter((e) => e.from === id)
}

export const FIRST_CHECKPOINT = CHECKPOINTS[0].id
export const LAST_CHECKPOINT = EDGES.find((e) => e.to === 'wrapup')?.from ?? null

/** 角色 → 该角色服务过哪些 checkpoint（用来判断 session 该不该复用） */
export function checkpointsOfRole(role) {
  return CHECKPOINTS.filter((c) => c.role === role).map((c) => c.id)
}

/**
 * 守卫注册表——边上 when 的实现。输入校验结果和回执，决定这条边走不走。
 *
 * 评审这道闸门由 bridge 判，不由 agent 判——agent 只报告「有哪些问题」，
 * 「这些问题够不够拦下流程」是编排决策。
 */
export const GUARDS = {
  /** 无条件放行：评审链（dev→review→fix→re-review）产出互为输入，由闸门把质量关 */
  auto: () => true,

  /**
   * 产出后必须等用户回答（需求澄清）：疑点清单是给人答的，不能自己往下走。
   * 走这条边的节点，等待会带 advanceTo，用户回答后直接到边指向的下一站。
   */
  waitUser: () => true,

  /**
   * 常规产物流转：这条边永远可走。停不停等（approval=manual 时要人看过）
   * 是 advance 拿到边之后的决策，不是边的资格——守卫只回答「能不能走」，
   * 不回答「要不要停」。混在一起会出现 auto 模式下无边命中、流程误报 blocked。
   */
  approve: () => true,

  /**
   * 合并进主分支：语义与 approve 相同，单独命名只为图上可读
   * （merge→wrapup 这条边是流程终点，渲染时高亮）。
   */
  approveForce: () => true,

  /**
   * 评审闸门（命中=有未闭环的阻断/应修项，走 fix）：
   * 判定依据是回执的 blockers，不是评审报告的行文——报告是给人看的，
   * 回执才是机器读的。这条边界守不住，又会退化成解析自然语言。
   */
  hasBlockers: (state, receipt) => {
    const blocking = (receipt?.blockers ?? []).filter((b) => b?.severity !== 'suggestion')
    if (!blocking.length) return false
    // 已经修过 MAX_RETRY 轮还在卡，就不再自动循环，交用户决策
    const rounds = state.rounds?.fix ?? 0
    if (rounds >= MAX_RETRY) throw guardStop(`评审返工 ${rounds} 轮仍有 ${blocking.length} 项未闭环`)
    return true
  },

  /** 评审闸门放行（全闭环） */
  noBlockers: (state, receipt) => {
    const blocking = (receipt?.blockers ?? []).filter((b) => b?.severity !== 'suggestion')
    return blocking.length === 0
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

/** 当前 checkpoint；跑完返回 null。并行 wave 时 current 是数组，取清单第一项 */
export function currentCheckpoint(state) {
  const id = Array.isArray(state.current) ? state.current[0] : state.current
  return id ? getCheckpoint(id) : null
}

/** 当前是否在并行 wave 中（current 是数组） */
export function isParallel(state) {
  return Array.isArray(state.current)
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
 * @returns {{action: string, state: object, reason?: string, checkpoint?: object|object[]}}
 *   action:
 *     continue   进入下一 checkpoint
 *     parallel   进入一波并行 checkpoint（checkpoint 是数组，join 屏障见 settleParallel）
 *     wait_user  等用户回答（waiting 里带 questions）
 *     retry      同一 checkpoint 返工
 *     blocked    停下等用户决策
 *     done       全流程结束
 *     bridge     bridge 自己执行（wrapup），不派 agent
 */
export function advance(state, receipt, verify = { ok: true }, opts = {}) {
  const cp = currentCheckpoint(state)
  if (!cp) return { action: 'done', state: { ...state, status: 'done' }, reason: '流程已结束' }

  const nextState = {
    ...state,
    rounds: { ...state.rounds },
    history: [...state.history],
  }

  // ── bridge 自己的动作：wrapup ──
  // 这个动作是同步完成的；终点节点没有出边，bridge 执行完流程即结束。
  // bridge 拿到 action=bridge 后执行动作，用返回的 state 继续。
  if (!needsAgent(cp)) {
    nextState.current = null
    nextState.status = 'done'
    nextState.waiting = null
    return { action: 'bridge', state: nextState, checkpoint: cp, reason: null }
  }

  // ── agent 报告需要用户输入：停在这里，把问题带出去 ──
  if (receipt?.status === 'needs_input') {
    nextState.status = 'waiting_user'
    // 这个节点本来就有「产出后等用户回答」的边（需求澄清），
    // 那么回答完应该推进到那条边的终点，而不是原地重跑一遍澄清。
    // 少了这一行，用户回答完会一直卡在需求澄清——实测踩到过。
    const answerEdge = edgesOf(cp.id).find((e) => e.when === 'waitUser')
    nextState.waiting = {
      checkpointId: cp.id,
      decisions: receipt.decisions ?? [],
      // agent 这次调用自己起的问题总标题，原样带到卡片上；没报就没有
      ...(receipt.decisionsTitle ? { decisionsTitle: receipt.decisionsTitle } : {}),
      ...(answerEdge ? { advanceTo: answerEdge.to } : {}),
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

  // ── 通过：按声明顺序求值出边守卫，第一条命中的决定去向 ──
  // 守卫都不命中就 blocked 兜底（图配错了不该静默走丢）。
  // ctx 就是状态本身加 requireApproval——守卫里读 state.rounds 之类直接可用。
  // 条件路由：when 也可以是函数（如按需求属性选测试链路），和注册表守卫一个待遇。
  const ctx = { ...nextState, requireApproval: opts.requireApproval === true }
  let picked = null
  for (const edge of edgesOf(cp.id)) {
    const guard = typeof edge.when === 'function' ? edge.when : GUARDS[edge.when]
    if (!guard) throw new Error(`未定义的守卫：${edge.when}（边 ${cp.id} → ${edge.to}）`)
    try {
      if (guard(ctx, receipt)) { picked = edge; break }
    } catch (err) {
      // 守卫主动喊停（如评审返工超限）：不再自动循环，交用户决策
      if (err?.guardStop) {
        nextState.status = 'blocked'
        nextState.waiting = { checkpointId: cp.id, decisions: [], reason: err.reason }
        return { action: 'blocked', state: nextState, checkpoint: cp, reason: err.reason }
      }
      throw err
    }
  }
  if (!picked) {
    nextState.status = 'blocked'
    nextState.waiting = { checkpointId: cp.id, decisions: [], reason: `「${cp.label}」没有可走的出边（图配置错误）` }
    return { action: 'blocked', state: nextState, checkpoint: cp, reason: `「${cp.label}」没有可走的出边（图配置错误）` }
  }

  // fan-out：to 是数组 = 并行分支。current 变成数组（一波同时跑），
  // 每个分支各自跑各自的回合；汇合点（join: true 的节点）等这一波全部达标才进。
  const targets = Array.isArray(picked.to) ? picked.to : [picked.to]
  if (targets.length > 1) {
    nextState.current = targets
    nextState.status = 'running'
    nextState.waiting = null
    // parallel 计数是汇合点的等待清单，join 时逐个销账
    nextState.rounds = { ...nextState.rounds, _parallel: [...targets] }
    return { action: 'parallel', state: nextState, checkpoint: targets.map(getCheckpoint) }
  }

  const to = targets[0]

  // 评审闸门放行到 fix 时，返工计数按「修了几轮」算
  if (to === 'fix') {
    nextState.rounds.fix = (nextState.rounds.fix ?? 0) + 1
  }

  // 产出后要等用户回答的节点（需求澄清）：停在原地，不推进 current。
  // 推进藏在 waiting.advanceTo 里，等用户回答后由 resumeFromUser 解开。
  // 先设 current 再判断的话，状态会「看起来已经到了下一阶段」，面板和播报都会错。
  if (picked.when === 'waitUser') {
    nextState.status = 'waiting_user'
    nextState.waiting = {
      checkpointId: cp.id,
      decisions: receipt?.decisions ?? [],
      ...(receipt?.decisionsTitle ? { decisionsTitle: receipt.decisionsTitle } : {}),
      advanceTo: to,
    }
    return { action: 'wait_user', state: nextState, checkpoint: cp, reason: null }
  }

  // 手动批准模式：各阶段产物要人看过再往下走。
  // 不加这段，approval=manual 形同虚设——实测 PRD 刚写完就直接进了设计，
  // 再往下就是开发改源码，没有人按住它。auto 模式（含 merge）直通：
  // 用户拍板 2026-11-26，无人值守跑到底是 auto 模式的卖点。
  const mustApprove = (picked.when === 'approveForce' || picked.when === 'approve') && ctx.requireApproval
  if (mustApprove) {
    nextState.status = 'waiting_user'
    // agent 在这一阶段问的疑点不能因为「等确认」就丢掉，一起带给用户
    nextState.waiting = {
      checkpointId: cp.id,
      decisions: receipt?.decisions ?? [],
      ...(receipt?.decisionsTitle ? { decisionsTitle: receipt.decisionsTitle } : {}),
      advanceTo: to,
      approve: true,
    }
    return { action: 'wait_user', state: nextState, checkpoint: cp, reason: null }
  }

  nextState.current = to
  nextState.status = 'running'
  nextState.waiting = null

  return { action: 'continue', state: nextState, checkpoint: getCheckpoint(to) }
}

/**
 * 并行分支销账：一个分支达标就把它从等待清单划掉。
 * 清单空了 = 汇合点可以进了，返回汇合点 id；否则返回 null 继续等。
 *
 * 分支失败不连坐：单个分支 blocked/超限时整个 wave 转 blocked 交用户
 * （在 bridge 的 onCheckpointEnd 里处理），这里只管「都成了」的快路径。
 */
export function settleParallel(state, checkpointId) {
  const wave = state.rounds?._parallel
  if (!Array.isArray(wave)) return null
  const rest = wave.filter((id) => id !== checkpointId)
  if (rest.length) {
    state.rounds = { ...state.rounds, _parallel: rest }
    return null
  }
  const { _parallel, ...rounds } = state.rounds
  state.rounds = rounds
  // 汇合点 = 所有等待分支的出边共同指向的下一站（图上 fan-out 的 join）
  const joins = EDGES
    .filter((e) => wave.includes(e.from))
    .map((e) => e.to)
  const join = joins.find((id) => joins.every((j) => j === id))
  return join ?? null
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

/**
 * 确认卡上点「打回」：这一阶段重做，而不是继续往下走。
 *
 * 之前任何回答都按 waiting.advanceTo 推进——用户点打回，流程照样进下一阶段，
 * 这道闸门等于没设（实测：技术方案被打回，开发照常开跑）。返工计数跟着涨，
 * 超过 MAX_RETRY 就停下等用户决定，和产物不达标走同一套上限。
 */
export function reworkFromUser(state, reason = '') {
  if (state.status !== 'waiting_user') return { state, action: 'none', reason: '' }
  const cpId = state.waiting?.checkpointId ?? state.current
  const cp = typeof cpId === 'string' ? getCheckpoint(cpId) : null
  const round = (state.rounds?.[cpId] ?? 0) + 1
  const next = {
    // 停在原地：current 不动，waiting 清空，回合重跑同一个 checkpoint
    ...state,
    status: 'running',
    waiting: null,
    rounds: { ...state.rounds, [cpId]: round },
  }
  if (round > MAX_RETRY) {
    const why = `「${cp?.label ?? cpId}」被打回 ${round - 1} 轮，停在这里等你的指示`
    return {
      state: { ...next, status: 'blocked', waiting: { checkpointId: cpId, decisions: [], reason: why } },
      action: 'blocked',
      reason: why,
    }
  }
  return { state: next, action: 'rework', reason: String(reason ?? '').trim() }
}

// resumeFromUser 的 advanceTo 在并行 wave 中不会有：等待（确认卡/提问卡）
// 只发生在单节点上；wave 里的分支 blocked 走 retryBlocked（清轮次重跑整个 wave），
// 不走 resumeFromUser——所以这里不需要处理数组 current。

/** 可读的缺口描述 */
function missingReason(missing) {
  return missing?.length ? `缺少产物：${missing.join('、')}` : '产物校验未通过'
}

/**
 * 守卫主动喊停用的异常（如评审返工超限）。advance 捕获后转 blocked，
 * 不再自动循环，交用户决策。普通异常照常上抛——那才是真的 bug。
 */
export function guardStop(reason) {
  return { guardStop: true, reason }
}
