/**
 * 产物回传：回合结束后找出新生成/改动的需求文档与截图，发到群里。
 *
 * 判定方式不依赖 git（项目可能不是干净仓库）：每回合前后各扫一次
 * docs/requirements 的 mtime + size 快照，取差集。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, basename, relative } from 'node:path'

const DOC_ROOT = 'docs/requirements'

/**
 * 阶段状态算不算「正在跑」。
 *
 * 只认两个端点：写明「已完成」就是结束，「未开始 / 待起」就是没动，其余一律
 * 当作进行中。编排记录是 agent 写的，状态列它会自由发挥（「定稿中」「返工中」
 * 都出现过），以前按字面匹配「进行中」，一换词回执和心跳就集体退化成
 * 「当前没有进行中的阶段」——用户发「继续」时真踩到过。
 */
export function isStageRunning(status) {
  const s = String(status ?? '').trim()
  if (!s) return false
  if (s.includes('已完成')) return false
  if (s.includes('未开始') || s.includes('待起')) return false
  return true
}

/**
 * 递归扫需求目录，返回 path → {mtimeMs, size}
 * @param {string} projectDir 项目根
 * @param {string} [onlyReqId] 只扫这一个需求目录（避免把别的需求的历史文件也回传）
 */
export function snapshot(projectDir, onlyReqId) {
  const root = onlyReqId ? join(projectDir, DOC_ROOT, onlyReqId) : join(projectDir, DOC_ROOT)
  const out = new Map()
  if (!existsSync(root)) return out

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile()) {
        try {
          const st = statSync(full)
          out.set(full, { mtimeMs: st.mtimeMs, size: st.size })
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(root)
  return out
}

/**
 * 群投递白名单：每个阶段只回传一份产物，其余文件照常落盘、只是不回传。
 *
 * 依据 requirement-spec 的「bot 调用模式」一节：阶段 5（开发）没有投递物，
 * 编排记录只在阶段 9 收尾后才投一次。`test(rel)` 的 rel 是需求目录内的相对路径。
 */
const DELIVERABLES = [
  { stage: 1, label: '待提问清单', test: (rel) => rel === '待提问清单.md' },
  { stage: 2, label: 'PRD', test: (rel) => rel === 'PRD.md' },
  {
    stage: 3,
    label: '设计稿',
    test: (rel) =>
      /^design-images\/[^/]+\.(png|jpe?g)$/i.test(rel) ||
      /^figma-import\/[^/]+\.zip$/i.test(rel) ||
      /^figma-import[^/]*\.zip$/i.test(rel),
  },
  { stage: 4, label: '技术方案', test: (rel) => rel === '技术方案.md' },
  { stage: 6, label: '代码评审报告', test: (rel) => rel === '代码评审报告.md' },
  { stage: 7, label: '测试报告', test: (rel) => rel === '测试报告.md' },
  { stage: 8, label: '验收文档', test: (rel) => rel === '验收文档.md' },
  { stage: 9, label: '编排记录', test: (rel) => rel === '编排记录.md' },
]

/** 取 docs/requirements/<需求标识>/ 之内的相对路径；不在其内返回 null */
export function relWithinReq(filePath) {
  const marker = DOC_ROOT + '/'
  const idx = filePath.indexOf(marker)
  if (idx < 0) return null
  const rest = filePath.slice(idx + marker.length).split('/')
  return rest.length >= 2 ? rest.slice(1).join('/') : null
}

/**
 * 编排记录里的「收尾结论」是否已写。
 * 模板里那一段一开始只有 HTML 注释，写了才会有「判定：」行——靠它区分
 * 「过程更新」和「阶段 9 的收尾投递」，否则编排记录每阶段都会被回传。
 */
export function wrapupWritten(boardPath) {
  if (!existsSync(boardPath)) return false
  let text
  try {
    text = readFileSync(boardPath, 'utf8')
  } catch {
    return false
  }
  const head = text.match(/^##\s*收尾结论\s*$/m)
  if (!head) return false
  const rest = text.slice(head.index + head[0].length)
  const next = rest.search(/^##\s/m)
  const body = (next >= 0 ? rest.slice(0, next) : rest).replace(/<!--[\s\S]*?-->/g, '').trim()
  return /判定[:：]/.test(body)
}

/** 这份文件是不是本阶段该投到群里的产物 */
export function isDeliverable(filePath) {
  const rel = relWithinReq(filePath)
  if (!rel) return false
  const hit = DELIVERABLES.find((d) => d.test(rel))
  if (!hit) return false
  if (hit.stage === 9) {
    const board = filePath.slice(0, filePath.length - '编排记录.md'.length) + '编排记录.md'
    return wrapupWritten(board)
  }
  return true
}

/**
 * 对比快照，找出新增或改动文件。
 * @param {Map} before
 * @param {Map} after
 * @param {{patterns: string[], maxFiles: number, maxFileMB: number, accept?: (path: string) => boolean}} opts
 */
export function diffSnapshot(before, after, opts) {
  const keepExt = new Set(['.md', '.png', '.jpg', '.jpeg', '.zip'])
  const changed = []

  for (const [path, meta] of after) {
    const prev = before.get(path)
    if (prev && prev.mtimeMs === meta.mtimeMs && prev.size === meta.size) continue
    if (!keepExt.has(extname(path).toLowerCase())) continue
    if (meta.size > opts.maxFileMB * 1024 * 1024) continue
    // 先按白名单过滤再截断，否则需求卡片这类不该发的文件会挤掉真正的产物
    if (opts.accept && !opts.accept(path)) continue
    changed.push({ path, size: meta.size, isNew: !prev })
  }

  // 新增优先，其次按修改时间倒序
  changed.sort((a, b) => {
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1
    return (after.get(b.path)?.mtimeMs ?? 0) - (after.get(a.path)?.mtimeMs ?? 0)
  })

  return changed.slice(0, opts.maxFiles)
}

/**
 * 从路径里认出本次回合动过的需求标识。
 * 依据：docs/requirements/<需求标识>/... 里发生改动的文件集。
 * @param {Map} before 回合前快照
 * @param {Map} after 回合后快照
 * @returns {string[]} 涉及的需求标识列表
 */
export function touchedReqIds(before, after) {
  const ids = new Set()
  const prefix = DOC_ROOT + '/'
  for (const [path, meta] of after) {
    const prev = before.get(path)
    if (prev && prev.mtimeMs === meta.mtimeMs && prev.size === meta.size) continue
    const idx = path.indexOf(prefix)
    if (idx < 0) continue
    const rest = path.slice(idx + prefix.length)
    const id = rest.split('/')[0]
    if (id && !id.startsWith('.')) ids.add(id)
  }
  return [...ids]
}

/** 生成群文件里显示的名字，带需求标识前缀避免重名 */
export function uploadName(projectDir, filePath) {
  const rel = relative(join(projectDir, DOC_ROOT), filePath)
  const parts = rel.split('/')
  if (parts.length >= 2) return `${parts[0]}__${parts.slice(1).join('_')}`
  return basename(filePath)
}

/**
 * 从编排记录里读当前进行中的阶段名。
 * 用于心跳话术「正在XX阶段」，比笼统说「还在跑」有信息量。
 * @param {string} projectDir
 * @returns {{stage: string|null, reqId: string|null}}
 */
export function currentStage(projectDir) {
  // 复用 stageTable：两份实现各写各的列索引，正是「状态列插了新列就解析错位」
  // 那个 bug 的根源。这里只挑第一条在跑的阶段。
  const { reqId, stages } = stageTable(projectDir)
  const running = stages.find((st) => isStageRunning(st.status))
  return { stage: running?.name ?? null, reqId }
}

/**
 * 解析编排记录的「阶段进度」表——四类群消息的状态来源。
 *
 * skill 在每个阶段都会改写这张表，所以它是比 agent 自述更可靠的
 * 阶段真值。bridge 只读它、不读 agent 的 text。
 *
 * @param {string} projectDir
 * @param {string=} reqId 指定需求；不给则取最近改动的编排记录
 * @returns {{reqId: string|null, stages: Array<{name: string, status: string}>}}
 */
export function stageTable(projectDir, reqId) {
  const empty = { reqId: reqId ?? null, stages: [] }
  const root = join(projectDir, DOC_ROOT)
  if (!existsSync(root)) return empty

  let file = reqId ? join(root, reqId, '编排记录.md') : null
  if (!file || !existsSync(file)) {
    // 没指定或指定的不存在：退回「最近改动的编排记录」
    let newest = null
    try {
      for (const id of readdirSync(root)) {
        if (id.startsWith('.')) continue
        const f = join(root, id, '编排记录.md')
        if (!existsSync(f)) continue
        const mtime = statSync(f).mtimeMs
        if (!newest || mtime > newest.mtime) newest = { id, file: f, mtime }
      }
    } catch {
      return empty
    }
    if (!newest) return empty
    file = newest.file
    reqId = newest.id
  }

  let lines
  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch {
    return { reqId, stages: [] }
  }

  const stages = []
  let inSection = false
  let statusCol = 1 // 旧格式（| 阶段 | 状态 | 返工次数 |）里状态在第 2 列
  for (const line of lines) {
    const t = line.trim()
    if (/^##\s*阶段进度\s*$/.test(t)) {
      inSection = true
      continue
    }
    if (inSection && /^##\s/.test(t)) break
    if (!inSection) continue
    if (!t.startsWith('|')) continue

    // 不用 filter(Boolean)：空单元格会被丢掉，后面的列整体左移一位。
    const cells = t.split('|').map((c) => c.trim())
    if (cells[0] === '') cells.shift()
    if (cells[cells.length - 1] === '') cells.pop()
    if (cells.length < 2) continue

    // 状态列的位置交给表头决定。以前写死取第 2 列，requirement-spec 后来插了
    // 「执行 agent」「产物」两列，状态就被读成了 agent 名字，于是每一行都被
    // 当成进行中，群里的阶段播报永远停在第一步——真实踩了很久。
    if (cells[0] === '阶段') {
      const headAt = cells.indexOf('状态')
      if (headAt >= 0) statusCol = headAt
      continue
    }

    const rawName = cells[0]
    const status = cells[statusCol]
    if (!rawName || rawName.includes('---')) continue
    if (!status) continue

    // 「4 开发」→ name='开发', num='4'
    const m = rawName.match(/^(\d+)\s*(.+)$/)
    stages.push({
      num: m ? m[1] : null,
      label: rawName,
      name: (m ? m[2] : rawName).trim(),
      status,
    })
  }

  return { reqId, stages }
}

/**
 * 用编排记录的写入时间近似某阶段的开始时间。
 *
 * 阶段切换必然改写编排记录，所以它的 mtime 是比「记当前时间」更接近真实起点
 * 的近似值。超过 24 小时的记录不可信（那是很久以前的），退回当前时间。
 */
export function guessStageStart(projectDir, reqId) {
  try {
    const root = join(projectDir, DOC_ROOT)

    // 没指定需求时，必须和 stageTable 用同一套「最近改动」规则，
    // 否则两边可能指向不同需求——readdirSync 的顺序跟新旧无关。
    if (!reqId) {
      let newest = null
      for (const id of readdirSync(root)) {
        if (id.startsWith('.')) continue
        const f = join(root, id, '编排记录.md')
        if (!existsSync(f)) continue
        const mtime = statSync(f).mtimeMs
        if (!newest || mtime > newest.mtime) newest = { mtime }
      }
      if (!newest) return Date.now()
      return Date.now() - newest.mtime > 24 * 3600 * 1000 ? Date.now() : newest.mtime
    }

    const f = join(root, reqId, '编排记录.md')
    if (existsSync(f)) {
      const mtime = statSync(f).mtimeMs
      return Date.now() - mtime > 24 * 3600 * 1000 ? Date.now() : mtime
    }
  } catch {
    /* 落空就用当前时间 */
  }
  return Date.now()
}
