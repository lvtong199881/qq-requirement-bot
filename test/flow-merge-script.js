/**
 * 脚本化合并单测。
 *
 * 合并决定「主分支上到底有什么」，出错代价极端（丢别人的提交、推了没测过的树），
 * 所以这里用真 git 仓库跑，不 mock：建一个裸仓库当远端，一个开发工作区放 feature
 * 分支，一个合并工作区扮演 worktrees/_merge。
 *   node test/flow-merge-script.js
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { runMergeScript } from '../src/flow/merge-script.js'
import { gitRun } from '../src/infra/git.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'ignore' })

const roots = []
const tmp = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `${tag}-`))
  roots.push(d)
  return d
}

/** 造远端裸仓库 + 两条工作区（开发、合并），返回句柄 */
function fixture({ reqId = 'r1', name = '测试需求' } = {}) {
  const origin = tmp('origin')
  g(origin, ['init', '--bare', '-q', '-b', 'main'])

  // 种子工作区：往裸仓库塞一个初始提交
  const seed = tmp('seed')
  g(seed, ['init', '-q', '-b', 'main'])
  g(seed, ['config', 'user.email', 't@t'])
  g(seed, ['config', 'user.name', 't'])
  writeFileSync(join(seed, 'app.dart'), 'void main() {}\n')
  writeFileSync(join(seed, 'README.md'), 'init\n')
  g(seed, ['add', '-A'])
  g(seed, ['commit', '-q', '-m', 'init'])
  g(seed, ['remote', 'add', 'origin', origin])
  g(seed, ['push', '-q', 'origin', 'main'])

  // 开发工作区：feature 分支上改代码、写文档
  const dev = tmp('dev')
  g(dev, ['clone', '-q', origin, '.'])
  g(dev, ['config', 'user.email', 't@t'])
  g(dev, ['config', 'user.name', 't'])
  g(dev, ['checkout', '-q', '-b', `feature/${reqId}`])
  writeFileSync(join(dev, 'app.dart'), 'void main() { print("feature"); }\n')
  const docsSrc = join(dev, 'docs', 'requirements', reqId)
  mkdirSync(docsSrc, { recursive: true })
  writeFileSync(join(docsSrc, 'PRD.md'), '# 需求\n')
  writeFileSync(join(docsSrc, '_receipt-dev.json'), JSON.stringify({ status: 'done' }))
  g(dev, ['add', '-A'])
  g(dev, ['commit', '-q', '-m', 'feat: 实现'])

  // 合并工作区：主分支副本，扮演 worktrees/_merge
  const merge = tmp('merge')
  g(merge, ['clone', '-q', origin, '.'])
  g(merge, ['config', 'user.email', 't@t'])
  g(merge, ['config', 'user.name', 't'])
  const reqDir = join(merge, 'docs', 'requirements', reqId)
  mkdirSync(reqDir, { recursive: true })

  return { origin, dev, merge, reqDir, reqId, name, docsSrc }
}

const run = (f, extra = {}) =>
  runMergeScript({
    workDir: f.merge,
    devDir: f.dev,
    docsSourceDir: join(f.dev, 'docs', 'requirements', f.reqId),
    reqDir: f.reqDir,
    repoDir: f.origin,
    reqId: f.reqId,
    name: f.name,
    mainBranch: 'main',
    ...extra,
  })

console.log('\n== 快进合并：代码进主分支、文档折进同一个合并提交 ==')
{
  const f = fixture()
  const r = run(f)
  check('合并成功', r.ok === true, JSON.stringify(r))
  const head = gitRun(f.merge, ['rev-parse', 'HEAD']).out
  const parents = gitRun(f.merge, ['rev-list', '--parents', '-n1', 'HEAD']).out.split(' ').slice(1)
  check('合并提交有两个父提交', parents.length === 2, parents.join(','))
  check('合并提交信息带需求号', gitRun(f.merge, ['log', '-1', '--format=%s']).out.includes('（r1）'))
  // 合并提交默认没有 diff，要和第一父提交比才看得到「这次合并带进来的东西」
  const files = gitRun(f.merge, ['diff', '--name-only', `${head}^1`, head]).out.split('\n').map((s) => s.trim())
  check('文档进了同一个提交', files.includes('docs/requirements/r1/PRD.md'), files.join('|'))
  check('代码改动也在合并提交里', files.includes('app.dart'), files.join('|'))
  // amend 会保持父提交不变：第二父提交仍是 feature 的最新提交，
  // 说明文档是折进合并提交的，而不是又叠了一个 docs 提交
  check('只产生一个合并提交（没有额外的 docs 提交）',
    gitRun(f.merge, ['rev-parse', 'HEAD^2']).out === gitRun(f.dev, ['rev-parse', 'HEAD']).out)
  check('已推到远端主分支', gitRun(f.origin, ['rev-parse', 'main']).out === head)
  check('远端能看到文档', gitRun(f.origin, ['show', 'main:docs/requirements/r1/PRD.md']).ok === true)

  const receipt = JSON.parse(readFileSync(join(f.reqDir, '_receipt-merge.json'), 'utf8'))
  check('回执状态 done', receipt.status === 'done', JSON.stringify(receipt.status))
  check('回执写了合并提交号', receipt.summary.includes(head.slice(0, 7)))
  check('回执写了归档数量', /归档 docs\/requirements\/r1\/ 共 2 个文档/.test(receipt.summary), receipt.summary)
  check('回执 artifacts 含代码文件', receipt.artifacts.some((a) => a.path === 'app.dart' && a.action === 'modified'))
  check('回执 artifacts 不含文档目录以外的 docs 文件',
    receipt.artifacts.some((a) => a.path === 'docs/requirements/r1/' && a.action === 'created'))
}

console.log('\n== 开发工作区有未提交改动：先补提交再合并，改动不能丢 ==')
{
  const f = fixture({ reqId: 'r2' })
  // 模拟 agent 写完代码忘了提交（实测常见），文档也在工作区里没进分支
  writeFileSync(join(f.dev, 'app.dart'), 'void main() { print("dirty"); }\n')
  writeFileSync(join(f.dev, 'late.dart'), '// 晚到的文件\n')
  const r = run(f)
  check('合并成功', r.ok === true, JSON.stringify(r))
  check('未提交的改动进了主分支',
    gitRun(f.origin, ['show', 'main:app.dart']).out.includes('dirty'))
  check('未提交的新文件也进了主分支',
    gitRun(f.origin, ['show', 'main:late.dart']).out.includes('晚到的文件'))
}

console.log('\n== 冲突：中止并报出冲突文件，不留半个合并状态 ==')
{
  const f = fixture({ reqId: 'r3' })
  // 远端主分支与 feature 改同一个文件同一行，必然冲突
  writeFileSync(join(f.merge, 'app.dart'), 'void main() { print("main side"); }\n')
  g(f.merge, ['commit', '-q', '-am', 'main side'])
  g(f.merge, ['push', '-q', 'origin', 'main'])
  writeFileSync(join(f.dev, 'app.dart'), 'void main() { print("feature side"); }\n')
  g(f.dev, ['commit', '-q', '-am', 'feature side'])

  const r = run(f)
  check('冲突时返回失败', r.ok === false, JSON.stringify(r))
  check('失败原因写清是冲突', /合并冲突（已中止）：app\.dart/.test(r.error ?? ''), r.error)
  check('没有留下进行中的合并', gitRun(f.merge, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok === false)
  check('主分支没被推上去', gitRun(f.origin, ['show', 'main:app.dart']).out.includes('main side'))
}

console.log('\n== 工作区不存在：直接报错，不猜 ==')
{
  const f = fixture({ reqId: 'r4' })
  const r = runMergeScript({
    workDir: join(f.merge, 'not-here'),
    devDir: f.dev,
    reqDir: f.reqDir,
    repoId: f.reqId,
    reqId: 'r4',
  })
  check('合并工作区不存在时失败', r.ok === false && /合并工作区不存在/.test(r.error ?? ''), JSON.stringify(r))
  const r2 = runMergeScript({
    workDir: f.merge,
    devDir: join(f.dev, 'not-here'),
    reqDir: f.reqDir,
    reqId: 'r4',
  })
  check('开发工作区不存在时失败', r2.ok === false && /开发工作区不存在/.test(r2.error ?? ''), JSON.stringify(r2))
  check('失败时不写回执', !existsSync(join(f.reqDir, '_receipt-merge.json')))
}

for (const d of roots) rmSync(d, { recursive: true, force: true })

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
