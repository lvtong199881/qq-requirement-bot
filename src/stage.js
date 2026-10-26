/**
 * 阶段相关的纯逻辑：回执文案、阶段播报计划、当前阶段的计时起点。
 *
 * 这些之前都写在 index.js 里，没有导出、也不好测——结果出现过
 * 「函数被删了但只有真跑群消息才报错」的事故。抽出来之后：
 *   · index.js 只负责编排与发送
 *   · 这里的函数可以直接单测，不需要起 bridge
 */
import { stageTable, guessStageStart } from './artifacts.js'
import { runningText } from './format.js'

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
 * 用户发消息后的回执文案（消息 1）。
 *
 * @param {object} st 群状态
 * @param {string} intent 意图
 * @returns {{text: string, reqIdToBind: string|null}}
 *   文本 + 建议写回的 reqId（绑定丢失时从编排记录找回）
 */
export function ackFor(st, intent) {
  const table = stageTable(st.projectDir, st.reqId ?? undefined)
  const { stages } = table
  const reqIdToBind = st.reqId ? null : (table.reqId ?? null)
  const running = stages.find((x) => x.status.includes('进行中'))

  // 进行中：不论用户说了什么，都只回一句状态（这是他要知道的全部）
  if (running) {
    return {
      text: runningText(running.name, resolveStageStart({ ...st, reqId: st.reqId ?? table.reqId }, running.name)),
      reqIdToBind,
    }
  }

  // 没有进行中阶段：按意图回执，避免同一句话重复出现
  const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
  const tag = lastDone ? `${lastDone.name}阶段已完成，` : ''
  const byIntent = {
    approve: `${tag}收到批准，正在启动下一阶段。`,
    reject: `${tag}收到修改意见，正在转给对应阶段处理。`,
    continue: `${tag}正在继续。`,
    new_req: '收到，开始新需求。',
  }
  const text = byIntent[intent] ?? (lastDone ? `${tag}等你确认。` : '当前没有进行中的阶段。')
  return { text, reqIdToBind }
}

/**
 * 计算这一回合要播报的阶段消息（消息 2），以及要写回 state 的字段。
 *
 * 阶段真值全部来自编排记录的「阶段进度」表，不看 agent 说了什么。
 * @returns {{messages: string[], running: string|null, finishedNow: string[], patch: object}}
 */
export function planStageAnnounce(st) {
  const table = stageTable(st.projectDir, st.reqId ?? undefined)
  const { stages } = table
  const reqIdForTime = st.reqId ?? table.reqId
  const running = stages.find((x) => x.status.includes('进行中'))?.name ?? null
  const finishedNow = stages.filter((x) => x.status.includes('已完成')).map((x) => x.name)

  const messages = []
  const patch = {}

  // 首次观测：把历史已完成阶段全部记为已知，避免把老阶段播报一遍
  const known = st.finishedStages
  if (known === null || known === undefined) {
    patch.finishedStages = finishedNow
  } else {
    const knownSet = new Set(known)
    for (const name of finishedNow) {
      if (!knownSet.has(name)) {
        messages.push(`${name}阶段已完成。`)
        patch.finishedStages = [...finishedNow]
      }
    }
  }

  // 阶段切换 → 播报「已开始」，并重置阶段计时
  if (running && running !== st.stage) {
    messages.push(`${running}阶段已开始。`)
    patch.stage = running
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

  return { messages, running, finishedNow, patch }
}
