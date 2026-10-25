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
 * 对比快照，找出新增或改动文件。
 * @param {Map} before
 * @param {Map} after
 * @param {{patterns: string[], maxFiles: number, maxFileMB: number}} opts
 */
export function diffSnapshot(before, after, opts) {
  const keepExt = new Set(['.md', '.png', '.jpg', '.jpeg'])
  const changed = []

  for (const [path, meta] of after) {
    const prev = before.get(path)
    if (prev && prev.mtimeMs === meta.mtimeMs && prev.size === meta.size) continue
    if (!keepExt.has(extname(path).toLowerCase())) continue
    if (meta.size > opts.maxFileMB * 1024 * 1024) continue
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
  const root = join(projectDir, DOC_ROOT)
  if (!existsSync(root)) return { stage: null, reqId: null }

  // 找最近改动的编排记录
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
    return { stage: null, reqId: null }
  }
  if (!newest) return { stage: null, reqId: null }

  let lines
  try {
    lines = readFileSync(newest.file, 'utf8').split('\n')
  } catch {
    return { stage: null, reqId: newest.id }
  }

  // 定位「## 阶段进度」小节，逐行扫描到下一个二级标题为止。
  // 用逐行扫描而不是正则切分：中文标题 + 表格里的竖线容易让正则出意外。
  let inSection = false
  for (const line of lines) {
    const t = line.trim()
    if (/^##\s*阶段进度\s*$/.test(t)) {
      inSection = true
      continue
    }
    if (inSection && /^##\s/.test(t)) break // 到下一个小节
    if (!inSection) continue
    if (!t.includes('进行中')) continue

    // 表格行：| 2 设计 | 进行中 | 0 | — |
    const cells = t.split('|').map((c) => c.trim()).filter(Boolean)
    if (cells.length === 0) continue
    const name = cells[0].replace(/^\d+\s*/, '').trim()
    if (name && !name.includes('---')) return { stage: name, reqId: newest.id }
  }
  return { stage: null, reqId: newest.id }
}
