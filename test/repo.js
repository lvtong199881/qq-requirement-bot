/**
 * bare 仓库与 worktree 管理单测。
 *
 * 这些逻辑决定「两个需求同时开发会不会互相踩」，出错代价极大，
 * 所以用真 git 仓库跑一遍，不 mock。
 *   node test/repo.js
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  isRepoReady,
  ensureBareRepo,
  detectMainBranch,
  createWorktree,
  removeWorktree,
  listWorktrees,
  ensureMergeWorktree,
  findOrphanWorktrees,
  pruneWorktrees,
} from '../src/infra/repo.js'
import { gitRun } from '../src/infra/git.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'ignore' })

/** 造一个「远端」仓库：有 main 分支和一个提交 */
function makeRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-'))
  g(dir, ['init', '-q', '-b', 'main'])
  g(dir, ['config', 'user.email', 't@t'])
  g(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README.md'), 'init')
  g(dir, ['add', '-A'])
  g(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

console.log('\n== bare 仓库初始化 ==')
{
  const remote = makeRemote()
  const root = mkdtempSync(join(tmpdir(), 'bot-'))
  const repoDir = join(root, 'repo.git')

  check('初始未就绪', !isRepoReady(repoDir))

  const r = ensureBareRepo({ repoDir, remoteUrl: remote, mainBranch: 'main' })
  check('初始化成功', r.ok, r.error)
  check('标记为新建', r.created === true)
  check('HEAD 就绪', isRepoReady(repoDir))

  // 三个关键坑：origin 指向远端、有 origin/main、HEAD 指向主分支
  const remoteUrl = gitRun(repoDir, ['remote', 'get-url', 'origin'])
  check('origin 指向远端而不是本地路径', remoteUrl.out === remote, remoteUrl.out)
  check('origin/main 存在（clone --bare 不会有）', gitRun(repoDir, ['rev-parse', '--verify', '--quiet', 'origin/main']).ok)
  check('HEAD 指向 refs/heads/main', gitRun(repoDir, ['symbolic-ref', 'HEAD']).out === 'refs/heads/main', gitRun(repoDir, ['symbolic-ref', 'HEAD']).out)
  check('检出主分支名正确', detectMainBranch(repoDir) === 'main', String(detectMainBranch(repoDir)))
  check('没有任何工作区文件（裸仓库）', !existsSync(join(repoDir, 'README.md')))

  const again = ensureBareRepo({ repoDir, remoteUrl: remote, mainBranch: 'main' })
  check('重复初始化幂等', again.ok && again.created === false)

  rmSync(root, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
}

console.log('\n== 创建 worktree ==')
{
  const remote = makeRemote()
  const root = mkdtempSync(join(tmpdir(), 'bot-'))
  const repoDir = join(root, 'repo.git')
  const worktreeRoot = join(root, 'worktrees')
  ensureBareRepo({ repoDir, remoteUrl: remote, mainBranch: 'main' })

  const w = createWorktree({ repoDir, worktreeRoot, reqId: 'abc12345', mainBranch: 'main' })
  check('创建成功', w.ok, w.error)
  check('路径正确', w.path === join(worktreeRoot, 'abc12345'), w.path)
  check('分支名正确', w.branch === 'feature/abc12345', w.branch)
  check('工作区有文件（checkout 过）', existsSync(join(w.path, 'README.md')))
  check('基于远端最新（stale=false）', w.stale === false)
  check('工作区自带 .git 目录（不是 worktree 指针文件）', existsSync(join(w.path, '.git', 'HEAD')))

  const same = createWorktree({ repoDir, worktreeRoot, reqId: 'abc12345', mainBranch: 'main' })
  check('重复创建复用已有目录', same.ok && same.existed === true)

  // 两个需求同时存在，互不干扰
  const w2 = createWorktree({ repoDir, worktreeRoot, reqId: 'def67890', mainBranch: 'main' })
  check('第二个需求也能建', w2.ok, w2.error)
  writeFileSync(join(w.path, 'only-a.txt'), 'a')
  check('A 的文件不出现在 B', !existsSync(join(w2.path, 'only-a.txt')))
  const b1 = gitRun(w.path, ['branch', '--show-current'])
  const b2 = gitRun(w2.path, ['branch', '--show-current'])
  check('两个工作区各自在 feature 分支上', b1.out?.trim() === 'feature/abc12345' && b2.out?.trim() === 'feature/def67890', `${b1.out?.trim()} / ${b2.out?.trim()}`)

  const list = listWorktrees(repoDir)
  check('listWorktrees 能列出', list.filter((x) => x.path.includes('abc12345')).length === 1)

  rmSync(root, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
}

console.log('\n== 回收 worktree ==')
{
  const remote = makeRemote()
  const root = mkdtempSync(join(tmpdir(), 'bot-'))
  const repoDir = join(root, 'repo.git')
  const worktreeRoot = join(root, 'worktrees')
  ensureBareRepo({ repoDir, remoteUrl: remote, mainBranch: 'main' })
  const w = createWorktree({ repoDir, worktreeRoot, reqId: 'gone0001', mainBranch: 'main' })

  const r = removeWorktree({ repoDir, path: w.path, branch: w.branch })
  check('回收成功', r.ok, r.notes.join('; '))
  check('目录已删', !existsSync(w.path))
  check('本地分支已删', !gitRun(repoDir, ['rev-parse', '--verify', '--quiet', 'feature/gone0001']).ok)

  // 远端分支应保留（这里没有远端分支，验证的是不强行删远端）
  const again = removeWorktree({ repoDir, path: w.path, branch: w.branch })
  check('重复回收不报错', again.ok, again.notes.join('; '))

  rmSync(root, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
}

console.log('\n== 孤儿巡检 ==')
{
  const remote = makeRemote()
  const root = mkdtempSync(join(tmpdir(), 'bot-'))
  const repoDir = join(root, 'repo.git')
  const worktreeRoot = join(root, 'worktrees')
  ensureBareRepo({ repoDir, remoteUrl: remote, mainBranch: 'main' })
  createWorktree({ repoDir, worktreeRoot, reqId: 'alive001', mainBranch: 'main' })
  createWorktree({ repoDir, worktreeRoot, reqId: 'dead0001', mainBranch: 'main' })

  const orphans = findOrphanWorktrees(repoDir, worktreeRoot, ['alive001'])
  check('找出不活跃的那个', orphans.length === 1 && orphans[0].reqId === 'dead0001', JSON.stringify(orphans))

  // 手动删目录后 prune 能清登记
  rmSync(join(worktreeRoot, 'dead0001'), { recursive: true, force: true })
  pruneWorktrees(repoDir)
  const after = listWorktrees(repoDir)
  check('prune 清掉失效登记', !after.some((x) => x.path.includes('dead0001')), JSON.stringify(after.map((x) => x.path)))

  rmSync(root, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
}

console.log('\n== 合并工作区 ==')
{
  const remote = makeRemote()
  const root = mkdtempSync(join(tmpdir(), 'bot-'))
  const repoDir = join(root, 'repo.git')
  const worktreeRoot = join(root, 'worktrees')
  ensureBareRepo({ repoDir, remoteUrl: remote, mainBranch: 'main' })

  const m = ensureMergeWorktree({ repoDir, worktreeRoot, mainBranch: 'main' })
  check('创建成功', m.ok, m.error)
  check('路径固定为 _merge', m.path === join(worktreeRoot, '_merge'))
  check('有工作区文件', existsSync(join(m.path, 'README.md')))

  const again = ensureMergeWorktree({ repoDir, worktreeRoot, mainBranch: 'main' })
  check('重复获取幂等', again.ok && again.path === m.path)

  const list = listWorktrees(repoDir)
  check('合并工作区是干净的独立工作区', existsSync(join(m.path, '.git', 'HEAD')))

  rmSync(root, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
}

console.log('\n== 非 git 目录 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'nogit-'))
  const r = ensureBareRepo({ repoDir: join(dir, 'x.git'), remoteUrl: join(dir, 'no-such-remote'), mainBranch: 'main' })
  check('远端不存在时报错而不是静默', !r.ok, JSON.stringify(r))
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
