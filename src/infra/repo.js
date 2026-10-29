/**
 * bare 仓库与 worktree 管理。
 *
 * bot 不持有任何「主工作区」——只有裸仓库和一堆按需创建的工作区。
 * 这样两个需求同时开发时不会互相 checkout 打断对方，因为根本不存在共享的工作目录。
 *
 * 为什么不直接 `git clone --bare`：它有三个坑（都实测过）
 *   1. origin 会指向源仓库的本地路径，导致 bot 读到未推送的提交
 *   2. refspec 直接映射到 refs/heads/*，不产生 refs/remotes/origin/*，`origin/main` 不存在
 *   3. HEAD 指向 clone 时的那个分支，不一定是主分支
 * 所以改用 `git init --bare` + 显式配置。
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { gitRun } from './git.js'

/** 裸仓库是否已初始化（看 HEAD 在不在） */
export function isRepoReady(repoDir) {
  return existsSync(join(repoDir, 'HEAD'))
}

/**
 * 初始化裸仓库。幂等：已初始化就直接返回。
 * @returns {{ok: true, created: boolean, mainBranch: string} | {ok: false, error: string}}
 */
export function ensureBareRepo({ repoDir, remoteUrl, mainBranch = 'main' }) {
  if (isRepoReady(repoDir)) {
    return { ok: true, created: false, mainBranch: detectMainBranch(repoDir) ?? mainBranch }
  }

  try {
    mkdirSync(repoDir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `创建仓库目录失败：${err.message}` }
  }

  const steps = [
    ['init', '--bare', '-q'],
    ['remote', 'add', 'origin', remoteUrl],
    // 关键：没有这行就不会有 origin/<branch>，worktree 无法基于远端最新创建
    ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['config', 'remote.origin.prune', 'true'],
  ]
  for (const args of steps) {
    const r = gitRun(repoDir, args)
    if (!r.ok) return { ok: false, error: `git ${args[0]} 失败：${r.error}` }
  }

  const fetched = gitRun(repoDir, ['fetch', 'origin'])
  if (!fetched.ok) return { ok: false, error: `fetch 失败：${fetched.error}` }

  gitRun(repoDir, ['symbolic-ref', 'HEAD', `refs/heads/${mainBranch}`])
  return { ok: true, created: true, mainBranch }
}

/**
 * 判断主分支。裸仓库里 `rev-parse --abbrev-ref HEAD` 可能给出任意分支，
 * 所以优先看 symbolic-ref 指向，其次 origin/HEAD，最后才退回 HEAD。
 */
export function detectMainBranch(repoDir) {
  const head = gitRun(repoDir, ['symbolic-ref', '--short', 'HEAD'])
  if (head.ok && head.out && head.out !== 'HEAD') return head.out

  const remoteHead = gitRun(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (remoteHead.ok && remoteHead.out) return remoteHead.out.replace(/^origin\//, '')

  for (const name of ['main', 'master']) {
    if (gitRun(repoDir, ['rev-parse', '--verify', '--quiet', `origin/${name}`]).ok) return name
  }
  return null
}

/** 远端同步：只取指定分支，失败时返回可读原因（调用方决定降级还是报错） */
export function fetchBranch(repoDir, branch) {
  const r = gitRun(repoDir, ['fetch', 'origin', branch])
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

/**
 * 为需求创建工作区。
 * 优先基于 origin/<主分支>（团队公认的最新起点）；fetch 失败则降级用本地同名引用。
 */
export function createWorktree({ repoDir, worktreeRoot, reqId, mainBranch }) {
  const path = join(worktreeRoot, reqId)
  const branch = `feature/${reqId}`

  // 「目录存在」不等于「工作区可用」：上次建到一半失败会留下空目录，
  // 直接复用就成了一个没有代码的工作区，agent 会在里面找不到任何文件。
  if (isUsableWorkspace(path)) return { ok: true, path, branch, existed: true, stale: false }

  try {
    mkdirSync(worktreeRoot, { recursive: true })
  } catch (err) {
    return { ok: false, error: `创建工作区根目录失败：${err.message}` }
  }

  // 建之前同步一次：需求从创建到进 dev 可能隔几天，起点要用最新
  let base = `origin/${mainBranch}`
  let stale = false
  const fetched = fetchBranch(repoDir, mainBranch)
  if (!fetched.ok) {
    stale = true
    base = mainBranch
    if (!gitRun(repoDir, ['rev-parse', '--verify', '--quiet', base]).ok) {
      return { ok: false, error: `无法确定起点分支：${fetched.error}` }
    }
  }

  // 分支已存在（返工/续跑）就复用，否则新建
  const branchExists = gitRun(repoDir, ['rev-parse', '--verify', '--quiet', branch]).ok

  // 不用 git worktree：它的 git 元数据在主仓里（~/.qq-bot/repo.git，工作区之外），
  // 在 worktree 里跑的 agent 一做 git add/commit 就被沙箱拒绝。
  //
  // 改成「工作区自带 .git」：init 一个新仓库，从主仓 fetch 起点提交，
  // 对象层用 alternates 只读引用主仓（实测 .git 只有 88 KB）。
  // 这样 agent 的 commit / merge / push 全部落在工作区内。
  mkdirSync(path, { recursive: true })
  const init = gitRun(path, ['init', '-q'])
  if (!init.ok) return { ok: false, error: `初始化工作区失败：${init.error}` }

  // 对象从这里读，只读
  mkdirSync(join(path, '.git', 'objects', 'info'), { recursive: true })
  writeFileSync(
    join(path, '.git', 'objects', 'info', 'alternates'),
    join(repoDir, 'objects') + '\n',
  )

  // 起点：分支已存在（返工/续跑）就从本地分支取，否则从主分支取。
  // 注意主仓是裸仓库，主分支在 refs/remotes/origin/* 下。
  const from = branchExists ? `refs/heads/${branch}` : base
  const pulled = gitRun(path, ['fetch', '--no-tags', repoDir, from])
  if (!pulled.ok) return { ok: false, error: `拉取起点失败：${pulled.error}` }

  const co = gitRun(path, ['checkout', '-q', '-b', branch, 'FETCH_HEAD'])
  if (!co.ok) return { ok: false, error: `检出分支失败：${co.error}` }

  // origin 指向真正的远端：主仓只当 clone 源，push 要推到真仓库，
  // 否则 push 会写主仓 —— 又跑到工作区外面去了。
  // 本地补一个 main 引用：diff、rebase、merge 都拿它当基线。
  // 不补的话 `git diff main...feature` 会因为本地没有 main 而退化成空 diff。
  const mainRef = gitRun(repoDir, ['rev-parse', '--verify', '--quiet', `origin/${mainBranch}`]).out?.trim()
  if (mainRef) gitRun(path, ['update-ref', `refs/heads/${mainBranch}`, mainRef])

  const remoteUrl = gitRun(repoDir, ['remote', 'get-url', 'origin']).out?.trim()
  if (remoteUrl) gitRun(path, ['remote', 'add', 'origin', remoteUrl])

  return { ok: true, path, branch, existed: false, stale, reusedBranch: branchExists }
}

/**
 * 移除需求工作区，并删掉本地 feature 分支。
 * 远端分支保留（追溯用），这里只动本地。
 */
export function removeWorktree({ repoDir, path, branch }) {
  const notes = []
  if (existsSync(path)) {
    // clone 出来的是普通目录（不是 worktree），直接删，不经过主仓
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (err) {
      notes.push(`移除工作区失败：${err.message}`)
    }
  }
  if (branch) {
    const r = gitRun(repoDir, ['branch', '-D', branch])
    // 分支本来就不存在不算错
    if (!r.ok && !/not found/i.test(r.error)) notes.push(`删除分支失败：${r.error}`)
  }
  return { ok: notes.length === 0, notes }
}

/** 工作区是否真的可用：是独立仓库、有 .git 目录、且检出过提交 */
function isUsableWorkspace(path) {
  if (!existsSync(path)) return false
  if (!existsSync(join(path, '.git', 'HEAD'))) return false
  return gitRun(path, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok
}


/**
 * 确保本地有一份仓库的「参考检出」，用来读代码、检测主分支、找构建产物。
 *
 * 配置里只给 git 链接就够了——不该要求每台机器先手动 clone 一遍。
 * 有这个函数之后，接入新项目就是「填个 URL」，剩下的 bot 自己干。
 *
 * 不是工作区：工作区是每个需求一份（createWorktree），这里每个仓库一份，
 * 只读用途，可以随时 fetch 更新。
 */
export function ensureCheckout({ checkoutDir, url, mainBranch }) {
  if (existsSync(join(checkoutDir, '.git'))) {
    // 已经有了：拉一下最新，拉不到就用本地的（离线时不该阻塞整个流程）
    const branch = mainBranch ?? detectMainBranch(checkoutDir) ?? 'main'
    const fetched = gitRun(checkoutDir, ['fetch', '--quiet', 'origin', branch])
    if (fetched.ok) {
      gitRun(checkoutDir, ['reset', '--hard', `origin/${branch}`])
      return { ok: true, updated: true, dir: checkoutDir, mainBranch: branch }
    }
    return { ok: true, updated: false, dir: checkoutDir, mainBranch: branch, note: '远端不可达，用本地副本' }
  }

  try {
    mkdirSync(dirname(checkoutDir), { recursive: true })
  } catch (err) {
    return { ok: false, error: `创建目录失败：${err.message}` }
  }

  let r = gitRun(dirname(checkoutDir), ['clone', '--quiet', url, checkoutDir])
  if (!r.ok && /proxy|SSL|connect|timeout|resolve host/i.test(r.error ?? '')) {
    // 本机 git 配了代理但代理不通，是最常见的克隆失败原因。
    // 直连再试一次，能通就不用管用户的代理设置。
    const direct = gitRun(dirname(checkoutDir), ['-c', 'http.proxy=', '-c', 'https.proxy=', 'clone', '--quiet', url, checkoutDir])
    if (direct.ok) {
      return {
        ok: true,
        created: true,
        dir: checkoutDir,
        mainBranch,
        note: '本机 git 代理不可用，已改用直连',
      }
    }
    r = direct
  }
  if (!r.ok) {
    return {
      ok: false,
      error: `克隆失败：${r.error}（如果是网络问题，检查本机 git 的 http.proxy 设置）`,
    }
  }

  const branch = mainBranch ?? detectMainBranch(checkoutDir) ?? 'main'
  return { ok: true, created: true, dir: checkoutDir, mainBranch: branch }
}

/**
 * 列出所有需求工作区。
 *
 * 工作区已经是独立的 clone（自带 .git），不再登记在主仓里，
 * 所以不能再靠 `git worktree list`——扫目录即可。
 */
export function listWorktrees(repoDir, worktreeRoot = join(repoDir, '..', 'worktrees')) {
  try {
    if (!existsSync(worktreeRoot)) return []
    return readdirSync(worktreeRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(worktreeRoot, d.name, '.git')))
      .map((d) => ({ path: join(worktreeRoot, d.name), branch: `feature/${d.name}` }))
  } catch {
    return []
  }
}

/** 旧实现（基于 git worktree 登记表），保留给还需要读老工作区的场景 */
function listWorktreesLegacy(repoDir) {
  const r = gitRun(repoDir, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return []
  const out = []
  let cur = null
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur)
      cur = { path: line.slice('worktree '.length).trim() }
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (cur && line.startsWith('detached')) {
      cur.detached = true
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 巡检：磁盘上已不存在的 worktree 还登记在仓库里 → 清掉登记。
 * 进程被杀 / 手动删目录后会出现这种残留，不清理会一直占着 worktree 配额。
 */
export function pruneWorktrees(repoDir) {
  const r = gitRun(repoDir, ['worktree', 'prune'])
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

/**
 * 找孤儿工作区：仓库登记了、但对应的需求已经不活跃。
 * 返回可回收的路径清单，调用方决定删不删（这里只报告，不动手）。
 */
export function findOrphanWorktrees(repoDir, worktreeRoot, activeReqIds) {
  const active = new Set(activeReqIds)
  const orphans = []
  // macOS 上 /var 会解析成 /private/var，直接比字符串会漏，统一走 realpath
  const rootReal = safeRealpath(worktreeRoot)
  for (const wt of listWorktrees(repoDir, worktreeRoot)) {
    const pathReal = safeRealpath(wt.path)
    const rel = relative(rootReal, pathReal)
    // 不在工作区根目录下的（比如别的仓库的 worktree）跳过
    if (!rel || rel.startsWith('..')) continue
    const name = rel.split(/[/\\]/)[0]
    if (!name || name === '_merge') continue
    if (!active.has(name)) orphans.push({ path: wt.path, reqId: name, branch: wt.branch })
  }
  return orphans
}

/** realpath 容错：路径不存在时退回原串 */
function safeRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * 合并专用工作区（全局唯一）。
 * detached 状态即可——每次合并前都会 reset 到 origin/<主分支>。
 */
export function ensureMergeWorktree({ repoDir, worktreeRoot, mainBranch }) {
  const path = join(worktreeRoot, '_merge')
  if (existsSync(path)) return { ok: true, path }
  try {
    mkdirSync(worktreeRoot, { recursive: true })
  } catch (err) {
    return { ok: false, error: `创建工作区根目录失败：${err.message}` }
  }
  // 和需求工作区一样：自带 .git，不受主仓路径限制
  mkdirSync(path, { recursive: true })
  const init = gitRun(path, ['init', '-q'])
  if (!init.ok) return { ok: false, error: init.error }

  mkdirSync(join(path, '.git', 'objects', 'info'), { recursive: true })
  writeFileSync(join(path, '.git', 'objects', 'info', 'alternates'), join(repoDir, 'objects') + '\n')

  const pulled = gitRun(path, ['fetch', '--no-tags', repoDir, `origin/${mainBranch}`])
  if (!pulled.ok) return { ok: false, error: `拉取主分支失败：${pulled.error}` }

  const co = gitRun(path, ['checkout', '-q', '-b', mainBranch, 'FETCH_HEAD'])
  if (!co.ok) return { ok: false, error: `检出主分支失败：${co.error}` }

  // 本地补一个 main 引用：diff、rebase、merge 都拿它当基线。
  // 不补的话 `git diff main...feature` 会因为本地没有 main 而退化成空 diff。
  const mainRef = gitRun(repoDir, ['rev-parse', '--verify', '--quiet', `origin/${mainBranch}`]).out?.trim()
  if (mainRef) gitRun(path, ['update-ref', `refs/heads/${mainBranch}`, mainRef])

  const remoteUrl = gitRun(repoDir, ['remote', 'get-url', 'origin']).out?.trim()
  if (remoteUrl) gitRun(path, ['remote', 'add', 'origin', remoteUrl])

  return { ok: true, path }
}

/** 需求数据目录（文档所在，不在 git 里） */
export function dataDirFor(dataRoot, reqId) {
  return join(dataRoot, reqId)
}

/** 确保数据目录存在 */
export function ensureDataDir(dataRoot, reqId) {
  const dir = dataDirFor(dataRoot, reqId)
  try {
    mkdirSync(dir, { recursive: true })
    return { ok: true, dir }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/** 列出数据目录下已有的需求（迁移和巡检用） */
export function listDataDirs(dataRoot) {
  try {
    return readdirSync(dataRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}
