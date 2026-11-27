/**
 * 流程有向图（EDGES）的静态工具：渲染 mermaid、启动前自检。
 *
 * 图定义在 flow.js（NODES=CHECKPOINTS + EDGES + GUARDS）。这里不存图，
 * 只消费图——图改了这里自动跟着对。渲染和校验都吃同一份 EDGES，
 * 不会出现「文档画的图和引擎跑的图不一致」。
 *
 * 校验在 bot 启动时跑一次（index.js），图配错直接 fail-fast：
 * 宁可不服务，也别跑到一半发现设计阶段的出边指了个不存在的节点。
 */
import { CHECKPOINTS, EDGES, GUARDS, FIRST_CHECKPOINT } from './flow.js'

/** 校验问题（不抛异常，收集后一次性报告） */
function collectIssues() {
  const issues = []
  const ids = new Set(CHECKPOINTS.map((c) => c.id))
  const edges = EDGES

  // 1. 边的两端必须是已声明的节点
  for (const e of edges) {
    if (!ids.has(e.from)) issues.push(`边的起点不是已声明节点：${e.from} → ${e.to}`)
    if (!ids.has(e.to)) issues.push(`边的终点不是已声明节点：${e.from} → ${e.to}`)
  }

  // 2. 边的守卫必须在 GUARDS 注册表里（拼错 when 的边会在这里现形）
  for (const e of edges) {
    if (!GUARDS[e.when]) issues.push(`边 ${e.from} → ${e.to} 的守卫未注册：${e.when}`)
  }

  // 3. 除终点外，每个节点都要有出边（死节点 = 跑到这流程就断）
  const terminal = new Set(edges.map((e) => e.to).filter((to) => !edges.some((e) => e.from === to)))
  for (const c of CHECKPOINTS) {
    if (!edges.some((e) => e.from === c.id) && !terminal.has(c.id)) {
      issues.push(`节点没有出边也不是终点：${c.id}`)
    }
  }

  // 4. 唯一起点：FIRST_CHECKPOINT 不能有入边（多个入口会让 initialState 意义不明）
  const entry = edges.filter((e) => e.to === FIRST_CHECKPOINT)
  if (entry.length) issues.push(`起点节点被指回来了（应为唯一入口）：${entry.map((e) => e.from).join('、')}`)

  // 5. 可达性：从起点沿一切边出发，所有节点都该可达（不可达 = 永远走不到的配置）
  const reach = new Set([FIRST_CHECKPOINT])
  let grew = true
  while (grew) {
    grew = false
    for (const e of edges) {
      if (reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); grew = true }
    }
  }
  for (const c of CHECKPOINTS) {
    if (!reach.has(c.id)) issues.push(`节点从起点不可达：${c.id}`)
  }

  // 6. 终点唯一：bridge 动作（无 role）节点应该是收尾，不该有出边
  for (const c of CHECKPOINTS) {
    if (!c.role && edges.some((e) => e.from === c.id)) {
      issues.push(`bridge 节点（无 role）不该有出边：${c.id}`)
    }
  }

  // 7. retry 自环的轮次上限由 MAX_RETRY 统一管（自环边不是显式声明的，
  //    这里只核对「每个 agent 节点至少有一条非自环出边」，否则会原地打转）
  for (const c of CHECKPOINTS) {
    if (!c.role) continue
    const outs = edges.filter((e) => e.from === c.id)
    if (outs.length === 0) issues.push(`agent 节点没有任何出边（会原地打转）：${c.id}`)
  }

  return issues
}

/**
 * 启动自检。图有问题就抛错（fail-fast），报清每一条问题。
 */
export function validateGraph() {
  const issues = collectIssues()
  if (issues.length) {
    throw new Error(`流程图配置有 ${issues.length} 处问题：\n  - ${issues.join('\n  - ')}`)
  }
}

/**
 * 渲染 mermaid 源码。边标注守卫类型，bridge 节点画成圆角终端，
 * 节点带角色标签。给 README / 群播报 / 确认卡用。
 */
export function renderMermaid() {
  const byId = new Map(CHECKPOINTS.map((c) => [c.id, c]))
  const whenLabel = {
    auto: '',
    waitUser: '|等用户回答|',
    approve: '|确认|',
    approveForce: '|拍板|',
    hasBlockers: '|有 blocker|',
    noBlockers: '|无 blocker|',
  }
  const lines = ['flowchart TD']
  for (const c of CHECKPOINTS) {
    const shape = c.role ? `["${c.label}"]` : `(["${c.label}"])`
    lines.push(`    ${c.id}${shape}`)
  }
  for (const e of EDGES) {
    const role = byId.get(e.to)?.role ? '' : ' :::terminal'
    lines.push(`    ${e.from} -->${whenLabel[e.when] ?? `|${e.when}|`} ${e.to}${role}`)
  }
  return lines.join('\n')
}

/** 渲染纯文本邻接表（日志友好，启动时打印一份核对） */
export function renderAdjacency() {
  return CHECKPOINTS.map((c) => {
    const outs = EDGES.filter((e) => e.from === c.id).map((e) => `${e.to}[${e.when}]`)
    return `${c.id} → ${outs.length ? outs.join(', ') : '(终点)'}`
  }).join('\n')
}
