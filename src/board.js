/**
 * 编排记录渲染：v2 下这份文档由 bridge 从状态机直接生成。
 *
 * 为什么不沿用 skill 的模板：那份模板是给 agent 写、给 bridge 反解析用的，
 * 在 v2 里两个用途都没了——agent 只写 _receipt.json，bridge 自己有状态。
 * 这里只负责给人看：现在跑到哪、每阶段过了几轮、卡在哪。
 *
 * 格式是 bridge 的私有格式，改版式不影响任何逻辑（不像 v1，改一列就可能解析错位）。
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CHECKPOINTS } from './flow.js'

const BOARD_FILE = '编排记录.md'
/** 分支路径不占主链的位置，单独在备注里体现 */
const BRANCH = new Set(['fix', 're-review', 'merge-fix'])

/**
 * 生成编排记录文本。
 * @param {object} flow flow.js 的流状态
 * @param {{now?: number}} [opts]
 */
export function renderBoard(flow, opts = {}) {
  const main = CHECKPOINTS.filter((c) => !BRANCH.has(c.id))
  const idx = main.findIndex((c) => c.id === flow.current)
  const blockedAt = flow.status === 'blocked' || flow.status === 'waiting_user' ? flow.current : null

  const rows = main.map((cp, i) => {
    let status = '未开始'
    if (idx >= 0 && i < idx) status = '已完成'
    else if (idx === i) {
      if (flow.status === 'done') status = '已完成'
      else if (flow.status === 'blocked') status = '阻塞'
      else if (flow.status === 'waiting_user') status = '等待确认'
      else status = '进行中'
    }
    const round = flow.rounds?.[cp.id]
    const roundText = round ? `${round}` : ''
    let note = ''
    if (cp.id === 'review' && flow.rounds?.fix) note = `评审修正 ${flow.rounds.fix} 轮`
    // 卡住原因不能把「修正了几轮」顶掉——两个都有信息量，拼起来
    if (blockedAt === cp.id && flow.waiting?.reason) {
      note = [note, flow.waiting.reason].filter(Boolean).join('；')
    }
    if (blockedAt === cp.id && flow.waiting?.checkpointId === 'commit') note = '等待用户确认提交'
    return `| ${cp.label} | ${status} | ${roundText} | ${note} |`
  })

  const lines = [
    `# 编排记录：${flow.reqId}`,
    '',
    '> 本文件由 bridge 从状态机自动生成，不要手改——下次状态变化会被覆盖。',
    '',
    '## 需求信息',
    '',
    `- 需求标识：${flow.reqId}`,
    `- 需求描述：${flow.requestText ?? '（无）'}`,
    `- 当前状态：${statusText(flow.status)}`,
    `- 当前阶段：${flow.current ? labelOf(flow.current) : '已结束'}`,
    `- 更新时间：${new Date(opts.now ?? Date.now()).toLocaleString('zh-CN')}`,
    '',
    '## 阶段进度',
    '',
    '| 阶段 | 状态 | 返工次数 | 备注 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ]

  if (flow.waiting?.decisions?.length) {
    lines.push('## 待决策', '')
    for (const d of flow.waiting.decisions) {
      lines.push(`- ${d.q}`)
      for (const [i, o] of (d.options ?? []).entries()) {
        lines.push(`  - ${String.fromCharCode(65 + i)}. ${o.text}${o.recommended ? '（推荐）' : ''}`)
      }
    }
    lines.push('')
  }

  if (flow.status === 'blocked') {
    lines.push('## 停点记录', '', `- 卡在：${labelOf(flow.current)}`, `- 原因：${flow.waiting?.reason ?? '未说明'}`, '')
  }

  return lines.join('\n')
}

/** 写到需求目录；失败不抛出（渲染失败不该让流程崩） */
export function writeBoard(reqDir, flow, opts) {
  try {
    if (!existsSync(reqDir)) mkdirSync(reqDir, { recursive: true })
    writeFileSync(join(reqDir, BOARD_FILE), renderBoard(flow, opts), 'utf8')
    return true
  } catch {
    return false
  }
}

function labelOf(id) {
  return CHECKPOINTS.find((c) => c.id === id)?.label ?? id ?? '未知'
}

function statusText(s) {
  return (
    { running: '进行中', waiting_user: '等你确认', blocked: '卡住了', done: '已完成' }[s] ?? s ?? '未知'
  )
}
