/**
 * 产物回传：回合结束后找出新生成/改动的需求文档与截图，发到群里。
 *
 * 判定方式不依赖 git（项目可能不是干净仓库）：每回合前后各扫一次
 * docs/requirements 的 mtime + size 快照，取差集。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
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
