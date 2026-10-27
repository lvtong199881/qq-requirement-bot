/**
 * feature 分支管理单测。
 *
 * 这套逻辑决定代码是不是落在独立分支上、主分支会不会被污染，
 * 出错代价大（提交到错误的分支），所以用真 git 仓库跑一遍。
 *   node test/git-branch.js
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { gitRun, detectMainBranch, ensureFeatureBranch, mergeFeature } from '../src/infra/git.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

/** 造一个干净的 git 仓库，默认分支 main，带一次提交 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'git-'))
  const g = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 'test@example.com'])
  g(['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'README.md'), 'init')
  g(['add', '-A'])
  g(['commit', '-q', '-m', 'init'])
  return dir
}

const currentBranch = (dir) => gitRun(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out

console.log('\n== 基本 git 操作 ==')
{
  const dir = makeRepo()
  check('gitRun 能跑', gitRun(dir, ['status']).ok)
  check('失败时返回 ok=false', !gitRun(dir, ['checkout', 'no-such-branch']).ok)
  check('失败时带错误信息', gitRun(dir, ['checkout', 'no-such-branch']).error.length > 0)
  check('识别主分支为 main', detectMainBranch(dir) === 'main', detectMainBranch(dir))
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n== 非 git 目录 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'nogit-'))
  const r = ensureFeatureBranch(dir, 'demo')
  check('报错而不是静默', !r.ok, JSON.stringify(r))
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n== 从主分支拉 feature ==')
{
  const dir = makeRepo()
  const r = ensureFeatureBranch(dir, 'welcome-modal')
  check('成功', r.ok, r.error)
  check('分支名正确', r.branch === 'feature/welcome-modal', r.branch)
  check('标记为新建', r.created === true)
  check('记录来源分支', r.from === 'main', r.from)
  check('当前确实在这个分支上', currentBranch(dir) === 'feature/welcome-modal', currentBranch(dir))
  check('主分支还在', gitRun(dir, ['rev-parse', '--verify', '--quiet', 'main']).ok)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n== 已存在就切过去，不重复建 ==')
{
  const dir = makeRepo()
  ensureFeatureBranch(dir, 'demo')
  gitRun(dir, ['checkout', 'main'])
  const again = ensureFeatureBranch(dir, 'demo')
  check('成功', again.ok, again.error)
  check('不标记为新建', again.created === false)
  check('切回了 feature 分支', currentBranch(dir) === 'feature/demo', currentBranch(dir))
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n== 当前不在主分支时，先回主分支再拉 ==')
{
  const dir = makeRepo()
  gitRun(dir, ['checkout', '-b', 'other'])
  const r = ensureFeatureBranch(dir, 'demo')
  check('从 main 拉而不是从 other', r.from === 'main', r.from)
  check('成功', r.ok, r.error)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n== 合并回主分支 ==')
{
  const dir = makeRepo()
  ensureFeatureBranch(dir, 'demo')
  writeFileSync(join(dir, 'feature.txt'), 'new')
  gitRun(dir, ['add', '-A'])
  gitRun(dir, ['commit', '-q', '-m', 'feat: add'])

  const r = mergeFeature(dir, 'demo')
  check('合并成功', r.ok, r.error)
  check('合到 main', r.main === 'main', r.main)
  check('当前回到主分支', currentBranch(dir) === 'main', currentBranch(dir))
  check('主分支上有 feature 的提交', gitRun(dir, ['log', '--oneline', 'main']).out.includes('feat: add'))
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n== 合并冲突：不自动选边，abort 保留现场 ==')
{
  const dir = makeRepo()
  ensureFeatureBranch(dir, 'demo')
  writeFileSync(join(dir, 'README.md'), 'feature version')
  gitRun(dir, ['add', '-A'])
  gitRun(dir, ['commit', '-q', '-m', 'feat: change readme'])

  gitRun(dir, ['checkout', 'main'])
  writeFileSync(join(dir, 'README.md'), 'main version')
  gitRun(dir, ['add', '-A'])
  gitRun(dir, ['commit', '-q', '-m', 'fix: main change'])

  const r = mergeFeature(dir, 'demo')
  check('报冲突而不是硬合', !r.ok && r.conflict === true, JSON.stringify(r))
  check('带分支和主分支信息', r.branch === 'feature/demo' && r.main === 'main')
  check('已 abort，工作区干净', gitRun(dir, ['status', '--porcelain']).out === '')
  check('主分支内容没被覆盖', readFileSync(join(dir, 'README.md'), 'utf8') === 'main version')
  check('feature 分支还在', gitRun(dir, ['rev-parse', '--verify', '--quiet', 'feature/demo']).ok)
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
