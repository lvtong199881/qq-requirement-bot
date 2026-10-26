/**
 * 阶段相关的纯逻辑：回执文案、阶段播报计划、当前阶段的计时起点。
 *
 * 这些之前都写在 index.js 里，没有导出、也不好测——结果出现过
 * 「函数被删了但只有真跑群消息才报错」的事故。抽出来之后：
 *   · index.js 只负责编排与发送
 *   · 这里的函数可以直接单测，不需要起 bridge
 */
import { stageTable, guessStageStart } from './artifacts.js'
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
 * 用户发消息后的回执文案（消息 1）。
 *
 * @param {object} st 群状态
 * @param {string} intent 意图
 * @returns {{text: string, reqIdToBind: string|null, idle: boolean}}
 *   文本 + 建议写回的 reqId + 是否是「什么都没开始」的空状态
 */
export function ackFor(st, intent, templates) {
  const table = stageTable(st.projectDir, st.reqId ?? undefined)
  const { stages } = table
  const reqIdToBind = st.reqId ? null : (table.reqId ?? null)
  const running = stages.find((x) => x.status.includes('进行中'))

  // 进行中：不论用户说了什么，都只回一句状态（这是他要知道的全部）
  if (running) {
    const start = resolveStageStart({ ...st, reqId: st.reqId ?? table.reqId }, running.name)
    const duration = start ? formatDuration(Date.now() - start) : ''
    return {
      text: renderMessage('ack', { stage: running.name, duration }, templates),
      reqIdToBind,
      idle: false,
    }
  }

  // 没有进行中阶段：按意图回执，避免同一句话重复出现
  const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
  const vars = {
    stageDone: lastDone?.name ?? '',
    target: st.reqId ? `需求 ${st.reqId}` : '当前需求',
    waitingLabel: st.waitingLabel || '',
  }

  if (!lastDone) {
    // 完全没有阶段的空群
    return { text: renderMessage('ackIdle', vars, templates), reqIdToBind, idle: stages.length === 0 }
  }

  // 有等待事项时，优先告诉用户「在等什么」。
  // 否则用户说「继续」会收到「验收阶段已完成，正在继续」——可他需要知道的是
  // 自己还欠一个决定（比如要不要推远端），这句话把真正的问题盖掉了。
  if (st.waitingLabel) {
    return { text: renderMessage('ackPendingLabel', vars, templates), reqIdToBind, idle: false }
  }

  // 需求确实收尾了、也没有等待事项：只有「继续」这种情况是真的没活干，
  // 换成「全部完成」的提示。其他意图（尤其新需求）照常走。
  const allDone = isRequirementDone(stages)
  if (allDone && intent === 'continue') {
    return { text: renderMessage('allDone', vars, templates), reqIdToBind, idle: false, allDone: true }
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
  const table = stageTable(st.projectDir, st.reqId ?? undefined)
  const { stages } = table
  const reqIdForTime = st.reqId ?? table.reqId
  const running = stages.find((x) => x.status.includes('进行中'))?.name ?? null
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

  return { messages, running, finishedNow, patch, completedNow, startedNow, done: requirementDone }
}
