/**
 * git 基础能力：分支、合并、冲突检测。
 *
 * 从 flow-bridge.js 里抽出来的——它和 QQ、和流程都无关，只是调用 git 命令。
 * 放在 infra/ 下表明它是「基础设施」，不依赖任何业务模块，可以被独立测试。
 */
import { execFileSync } from 'node:child_process'

/**
 * 跑 git 并返回结果。和 safeGit 的区别：这个不吞错误，调用方需要知道成没成。
 */
export function gitRun(cwd, args) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: String(out ?? '').trim() }
  } catch (err) {
    const stderr = String(err?.stderr ?? '').trim()
    return { ok: false, error: stderr || String(err?.message ?? 'git 执行失败') }
  }
}

/** 主分支名：main 优先，退回 master，都没有就用当前分支 */
export function detectMainBranch(cwd) {
  for (const name of ['main', 'master']) {
    if (gitRun(cwd, ['rev-parse', '--verify', '--quiet', name]).ok) return name
  }
  const cur = gitRun(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return cur.ok ? cur.out : 'main'
}

/**
 * 确保当前在 feature/<reqId> 分支上，从主分支拉出来。
 * 已存在就切过去（返工/续跑），不会再建一个。
 */
export function ensureFeatureBranch(cwd, reqId) {
  const desired = `feature/${reqId}`
  const cur = gitRun(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!cur.ok) return { ok: false, error: `不是 git 仓库：${cur.error}` }
  if (cur.out === desired) return { ok: true, branch: desired, created: false }

  if (gitRun(cwd, ['rev-parse', '--verify', '--quiet', desired]).ok) {
    const co = gitRun(cwd, ['checkout', desired])
    return co.ok ? { ok: true, branch: desired, created: false } : { ok: false, error: co.error }
  }

  // 必须从主分支拉：当前不在主分支就先回去
  const main = detectMainBranch(cwd)
  if (cur.out !== main) {
    const back = gitRun(cwd, ['checkout', main])
    if (!back.ok) return { ok: false, error: `切回 ${main} 失败：${back.error}` }
  }
  const create = gitRun(cwd, ['checkout', '-b', desired])
  return create.ok
    ? { ok: true, branch: desired, from: main, created: true }
    : { ok: false, error: create.error }
}

/** 把 feature 合回主分支。冲突不自动解决，交给人。 */
export function mergeFeature(cwd, reqId) {
  const branch = `feature/${reqId}`
  const main = detectMainBranch(cwd)
  const co = gitRun(cwd, ['checkout', main])
  if (!co.ok) return { ok: false, branch, error: `切到 ${main} 失败：${co.error}` }

  const r = gitRun(cwd, ['merge', '--no-ff', branch, '-m', `merge: ${branch}`])
  if (r.ok) return { ok: true, main, branch }

  // 冲突不自动选边。不管取哪边都可能覆盖掉另一边真实有效的改动，
  // 而且合并结果看起来「成功」，错得很安静。abort 掉保留现场，交给开发处理。
  gitRun(cwd, ['merge', '--abort'])
  return { ok: false, branch, main, conflict: true, error: r.error || '合并冲突' }
}
