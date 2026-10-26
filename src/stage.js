/**
 * 阶段相关的纯逻辑：回执文案、阶段播报计划、当前阶段的计时起点。
 *
 * 这些之前都写在 index.js 里，没有导出、也不好测——结果出现过
 * 「函数被删了但只有真跑群消息才报错」的事故。抽出来之后：
 *   · index.js 只负责编排与发送
 *   · 这里的函数可以直接单测，不需要起 bridge
 */
import { stageTable, guessStageStart, currentStage, isStageRunning } from './artifacts.js'
import { formatDuration } from './format.js'
import { renderMessage } from './messages.js'

/**
 * 当前进行中阶段的起始时间。
 *
 * state.stageStartedAt 只在回合收尾时更新。阶段刚切换（比如测试→验收）、
 * 这一回合还没结束时，阶段名是新的、时间戳是旧的，直接拿它算时长会跨阶段
 * 累加。这里做一次对齐：阶段名对不上就按编排记录重估起点。
 */
export function resolveStageStart(st, runningName) {
  if (!runningName) return null
  if (st.stage === runningName && st.stageStartedAt) return st.stageStartedAt
  return guessStageStart(st.projectDir, st.reqId)
}

/**
 * 这个需求算不算「已经全部做完了」。
 *
 * 新流程里由「需求收尾」阶段负责终检，它完成才算需求完成；
 * 老需求没有这个阶段时，退化为「所有阶段都已完成」。
 */
export function isRequirementDone(stages) {
  if (!stages.length) return false
  const wrapup = stages.find((x) => x.name.includes('需求收尾'))
  if (wrapup) return wrapup.status.includes('已完成')
  return stages.every((x) => x.status.includes('已完成'))
}

/**
 * 这个群是不是从没做过任何需求。
 *
 * 新群不该被别的需求的编排记录「冒充」：`stageTable` 在没给 reqId 时会退回
 * 「最近改动的编排记录」，新群里那条往往是一个已经收尾的需求，于是 @ 一下
 * 就被告知「本需求已全部完成」，还顺手把群绑定到了别人的需求上。
 */
export function isFreshGroup(st) {
  if (!st) return true
  // 有 reqId 就是绑定过的群（state.peek 已经把旧版本猜来的脏 reqId 滤掉了）
  if (st.reqId) return false
  // 否则看有没有真跑过回合：turn 在回合结束才 +1，sessionId 是 dsh 会话 id。
  // 不能拿 stage / finishedStages 判断——旧版本正是把猜来的阶段写进了这两个字段。
  return !st.turn && !st.sessionId
}

/**
 * 取这个群对应需求的阶段表。新群一律空表，不去猜别人的需求。
 * @returns {{reqId: string|null, stages: Array<{name: string, status: string}>}}
 */
export function groupStageTable(st) {
  if (isFreshGroup(st)) return { reqId: null, stages: [] }
  return stageTable(st.projectDir, st.reqId ?? undefined)
}

/** 从编排记录自愈恢复 reqId（bridge 重启、状态丢失时用）；新群不猜。 */
export function recoverReqId(st) {
  if (isFreshGroup(st)) return null
  return currentStage(st.projectDir).reqId ?? null
}

/**
 * 回合收尾时用的阶段信息（当前阶段 + 该绑定的 reqId）。
 *
 * 单独抽出来是因为漏过一次：收尾处直接调 currentStage(st.projectDir)，
 * 新群刚跑完第一个回合就把项目里「最近改动的编排记录」绑到了自己身上，
 * 于是群里冒出一句「本需求已全部完成」，之后还再也发不了新需求。
 * 所有需要「这个群对应哪个需求」的地方都走这里，别再各自调 currentStage。
 */
export function stageInfoFor(st) {
  if (isFreshGroup(st)) return { stage: null, reqId: null }
  return currentStage(st.projectDir)
}

/**
 * 用户发消息后的回执文案（消息 1）。
 *
 * @param {object} st 群状态
 * @param {string} intent 意图
 * @param {object} [templates] 群级话术覆盖
 * @param {{hasContent?: boolean}} [opts] 用户这句话是否带了内容（只 @ 不说话时为 false）
 * @returns {{text: string, reqIdToBind: string|null, idle: boolean}}
 *   文本 + 建议写回的 reqId + 是否是「什么都没开始」的空状态
 */
export function ackFor(st, intent, templates, opts = {}) {
  const { hasContent = true } = opts
  const table = groupStageTable(st)
  const { stages } = table
  const reqIdToBind = st.reqId ? null : (table.reqId ?? null)
  const running = stages.find((x) => isStageRunning(x.status))

  // 进行中：不论用户说了什么，都只回一句状态（这是他要知道的全部）
  if (running) {
    const start = resolveStageStart({ ...st, reqId: st.reqId ?? table.reqId }, running.name)
    const duration = start ? formatDuration(Date.now() - start) : ''
    const vars = { stage: running.name, duration, waitingLabel: st.waitingLabel || '' }
    // 阶段在跑、同时有等你拍板的事：两件事一起说，别只报时长
    return {
      text: renderMessage(st.waitingLabel ? 'ackWaiting' : 'ack', vars, templates),
      reqIdToBind,
      idle: false,
    }
  }

  // 没有进行中阶段：按意图回执，避免同一句话重复出现
  const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
  const reqId = st.reqId ?? table.reqId ?? ''
  const vars = {
    stageDone: lastDone?.name ?? '',
    target: reqId ? `需求 ${reqId}` : '当前需求',
    waitingLabel: st.waitingLabel || '',
    reqId,
    reqIdPad: reqId ? ` ${reqId} ` : '',
  }

  if (!lastDone) {
    // 空群里说了具体需求：回「当前没有进行中的阶段」等于没接住话头
    if (hasContent && intent === 'content') {
      return { text: renderMessage('ackKickoff', vars, templates), reqIdToBind, idle: false, kickoff: true }
    }
    // 只 @ 不说话、或说了别的：回到空状态话术（调用方会补引导）
    return { text: renderMessage('ackIdle', vars, templates), reqIdToBind, idle: stages.length === 0 }
  }

  // 需求已经全部收尾：先告诉用户这件事，别再提「等你确认」。
  // 收尾之后 agent 还可能残留一个 waitingLabel，拿它当回执会让人以为还有事要拍板。
  // 新需求也不放行——一个群只做一个需求，做完仍占着这个群。
  const allDone = isRequirementDone(stages)
  if (allDone) {
    const key = intent === 'new_req' ? 'groupTaken' : 'allDone'
    return {
      text: renderMessage(key, vars, templates),
      reqIdToBind,
      idle: false,
      allDone: true,
    }
  }

  // 有等待事项时，优先告诉用户「在等什么」。
  // 否则用户说「继续」会收到「验收阶段已完成，正在继续」——可他需要知道的是
  // 自己还欠一个决定（比如要不要推远端），这句话把真正的问题盖掉了。
  if (st.waitingLabel) {
    return { text: renderMessage('ackPendingLabel', vars, templates), reqIdToBind, idle: false }
  }

  const key = { approve: 'ackApprove', reject: 'ackReject', continue: 'ackContinue', new_req: 'ackNewReq' }[intent]
  return {
    text: renderMessage(key ?? 'ackPending', vars, templates),
    reqIdToBind,
    idle: false,
    allDone: false,
  }
}

/**
 * 计算这一回合要播报的阶段消息（消息 2），以及要写回 state 的字段。
 *
 * 阶段真值全部来自编排记录的「阶段进度」表，不看 agent 说了什么。
 * @returns {{messages: string[], running: string|null, finishedNow: string[], patch: object}}
 */
export function planStageAnnounce(st, templates) {
  // 新群没有阶段可播报，也不往状态里落 finishedStages（否则会写个空数组进去）
  if (isFreshGroup(st)) {
    return { messages: [], running: null, finishedNow: [], patch: {}, completedNow: [], startedNow: null, done: false }
  }
  const table = groupStageTable(st)
  const { stages } = table
  const reqIdForTime = st.reqId ?? table.reqId
  const running = stages.find((x) => isStageRunning(x.status))?.name ?? null
  const finishedNow = stages.filter((x) => x.status.includes('已完成')).map((x) => x.name)

  const messages = []
  const patch = {}

  // 哪些阶段是这一回合新完成的
  const known = st.finishedStages
  let completedNow = []
  if (known === null || known === undefined) {
    // 首次观测：把历史已完成阶段全部记为已知，不补报
    patch.finishedStages = finishedNow
  } else {
    const knownSet = new Set(known)
    completedNow = finishedNow.filter((n) => !knownSet.has(n))
    if (completedNow.length) patch.finishedStages = [...finishedNow]
  }

  const startedNow = running && running !== st.stage ? running : null
  if (startedNow) {
    patch.stage = startedNow
    // 用编排记录的最近写入时间近似阶段起点（阶段切换必然改写它），
    // 比记 Date.now() 更接近真实开始时刻。
    patch.stageStartedAt = guessStageStart(st.projectDir, reqIdForTime)
  } else if (running && !st.stageStartedAt) {
    // 老数据里 stage 已是当前阶段但缺时间戳：补一个，避免播报里没有时长
    patch.stageStartedAt = guessStageStart(st.projectDir, reqIdForTime)
  } else if (!running && st.stage) {
    // 阶段都完成了但还没进下一阶段：保留最后一次阶段名，避免回执说「没有阶段」
    patch.stage = st.stage
  }

  // 阶段推进合成一句话。分开报会出现「验收阶段进行中」后面紧跟
  // 「测试阶段已完成」这种看似矛盾的两条（真实踩过）。
  const done = completedNow.join('、')
  if (done && startedNow) {
    messages.push(renderMessage('stageAdvance', { stageDone: done, stageStarted: startedNow }, templates))
  } else if (done) {
    messages.push(renderMessage('stageDone', { stage: done }, templates))
  } else if (startedNow) {
    messages.push(renderMessage('stageStart', { stage: startedNow }, templates))
  }

  // 需求收尾阶段刚完成 → 需求真的结束了，补一句交付结论
  const justWrappedUp = completedNow.some((n) => n.includes('需求收尾'))
  const requirementDone = justWrappedUp && !running

  // 整个需求都收尾了：阶段名落到「需求收尾」，并且把过期的等待事项清掉——
  // 否则回执会继续说「XX阶段已完成，等你确认」，可实际上没有任何事在等用户。
  if (isRequirementDone(stages)) {
    patch.stage = '需求收尾'
    if (st.waitingLabel) patch.waitingLabel = ''
  }

  return { messages, running, finishedNow, patch, completedNow, startedNow, done: requirementDone }
}

/**
 * 心跳该报什么（消息 3）。
 *
 * 以前只在「有进行中阶段」时才发心跳。可阶段全部完成、agent 还在跑的场景很常见
 * （验收完又追加修 bug 就是），那时一条都不会发，群里能安静半小时以上，用户只能
 * 干等——真实踩过，以为 bot 卡死了。现在退回报回合总时长，任何回合都有进展可见。
 *
 * @param {object} st 群状态
 * @param {number} startedAt 本回合开始时间
 * @param {number} [now] 当前时间，测试用
 * @returns {{key: string, vals: object}} 交给 renderMessage 的模板键与变量
 */
export function heartbeatMessage(st, startedAt, now = Date.now()) {
  const { stages } = groupStageTable(st)
  const running = stages.find((x) => isStageRunning(x.status))

  if (running) {
    const start = resolveStageStart(st, running.name)
    return {
      key: 'heartbeat',
      vals: { stage: running.name, duration: start ? formatDuration(now - start) : '' },
    }
  }

  return { key: 'heartbeatRunning', vals: { duration: formatDuration(now - startedAt) } }
}
