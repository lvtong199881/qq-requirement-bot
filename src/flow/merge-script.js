/**
 * 合并阶段的脚本实现：把 agent 照 SKILL 打的那一串 git 命令直接执行掉。
 *
 * 为什么脚本化：合并是纯确定性搬运（fetch / merge --no-ff / 归档文档 / push /
 * 写回执），没有任何判断空间。实测两单分别花了 326s、748s，其中工具时间只有
 * 83s，剩下全是模型来回一遍遍打同样的命令——这部分钱不值得花。
 *
 * 边界：只做快进场景（main 自分支切出后没动过）。main 有新提交时三方合并
 * 会得到没人测过的新树，那种情况仍走 agent（它会在合并后重跑编译单测），
 * 判据由 flow-bridge 在回合开始前算好塞进 vars.mergeFastForward。
 *
 * 冲突不自动解决：取哪边都可能悄悄覆盖掉另一边真实有效的改动，abort 保留现场
 * 比「看起来成功」安全得多。
 */
import { cpSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gitRun } from '../infra/git.js'
import { readReceipt, receiptFile } from './orchestrator.js'

/** 提交身份固定写死：合并提交不该因为哪台机器而作者不同 */
const ID = ['-c', 'user.name=qq-bot', '-c', 'user.email=bot@local']

/** 递归数文件：回执里要写归档了多少个文档，人看总结时靠这个确认没漏 */
function countFiles(dir) {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) n += countFiles(p)
    else n += 1
  }
  return n
}

/**
 * 执行脚本化合并。
 *
 * @param {object} opts
 * @param {string} opts.workDir 合并工作区（专用的 worktrees/_merge）
 * @param {string} opts.devDir 开发工作区（feature 分支所在）
 * @param {string} opts.docsSourceDir 开发工作区里的文档目录（docs/requirements/<reqId>）
 * @param {string} opts.reqDir 回执要落到的目录（合并工作区里的同名需求目录）
 * @param {string} opts.repoDir 裸仓库目录（合并后把原主分支引用同步回去）
 * @param {string} opts.reqId 需求号
 * @param {string} [opts.name] 需求名（进合并提交信息）
 * @param {string} [opts.mainBranch] 主分支名
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ok: true, receipt: object} | {ok: false, error: string}}
 */
export function runMergeScript({
  workDir,
  devDir,
  docsSourceDir,
  reqDir,
  repoDir,
  reqId,
  name = '',
  mainBranch = 'main',
  log = () => {},
}) {
  if (!workDir || !existsSync(workDir)) return { ok: false, error: `合并工作区不存在：${workDir}` }
  if (!devDir || !existsSync(devDir)) return { ok: false, error: `开发工作区不存在：${devDir}` }

  const branch = `feature/${reqId}`
  const step = (msg) => log(`[merge] ${msg}`)

  // 0. 开发工作区还有没提交的改动就先提交：feature 分支里缺了它们，
  //    合并出来的主分支就少一段代码，而这种缺失在 diff 里看不出来。
  const dirty = gitRun(devDir, ['status', '--porcelain'])
  if (dirty.out?.trim()) {
    const got = readReceipt(join(devDir, 'docs/requirements', reqId), 'dev')
    const msg = got?.receipt?.commitMessage || `feat(${reqId}): ${name || '需求实现'}`
    const add = gitRun(devDir, ['add', '-A'])
    if (!add.ok) return { ok: false, error: `提交开发工作区改动失败（add）：${add.error}` }
    const commit = gitRun(devDir, [...ID, 'commit', '-q', '-m', msg])
    if (!commit.ok) return { ok: false, error: `提交开发工作区改动失败：${commit.error}` }
    step('开发工作区有未提交改动，已补一次提交')
  }

  // 1. 合并工作区回到远端主分支的最新状态。reset --hard 不动未跟踪文件，
  //    所以上一轮遗留的回执不会被误删（回收由 flow-bridge 在开工前做）。
  const fetchedMain = gitRun(workDir, ['fetch', '--no-tags', 'origin', mainBranch])
  if (!fetchedMain.ok) {
    const hasLocal = gitRun(workDir, ['rev-parse', '--verify', '--quiet', `origin/${mainBranch}`])
    if (!hasLocal.ok) return { ok: false, error: `拉取 origin/${mainBranch} 失败：${fetchedMain.error}` }
    step(`拉取 origin/${mainBranch} 失败（${fetchedMain.error}），改用本地已知的远端引用`)
  }
  const co = gitRun(workDir, ['checkout', '-f', mainBranch])
  if (!co.ok) return { ok: false, error: `切到 ${mainBranch} 失败：${co.error}` }
  const reset = gitRun(workDir, ['reset', '--hard', `origin/${mainBranch}`])
  if (!reset.ok) return { ok: false, error: `对齐 origin/${mainBranch} 失败：${reset.error}` }

  // 2. 取开发分支。两个工作区各自独立，靠本地路径互通（不需要网络）。
  const fetchedDev = gitRun(workDir, ['fetch', '--no-tags', devDir, branch])
  if (!fetchedDev.ok) return { ok: false, error: `拉取 ${branch} 失败：${fetchedDev.error}` }
  const featureSha = gitRun(workDir, ['rev-parse', 'FETCH_HEAD']).out
  if (!featureSha) return { ok: false, error: `取不到 ${branch} 的提交号` }

  // 3. 合并。冲突就中止，把冲突文件报出来，交给人决定取哪边。
  const merged = gitRun(workDir, [...ID, 'merge', '--no-ff', 'FETCH_HEAD', '-m', `merge: ${name || reqId}（${reqId}）`])
  if (!merged.ok) {
    const conflicted = gitRun(workDir, ['diff', '--name-only', '--diff-filter=U']).out?.trim()
    gitRun(workDir, ['merge', '--abort'])
    return { ok: false, error: `合并冲突（已中止）：${conflicted || merged.error}` }
  }

  // 4. 归档文档并折进同一个合并提交——和人工合并的做法一致：一次合并只留一个
  //    提交，历史上看不出「代码合了、文档晚了一步」这种偏差。
  let docCount = 0
  if (docsSourceDir && existsSync(docsSourceDir)) {
    const docsTarget = join(workDir, 'docs', 'requirements', reqId)
    mkdirSync(docsTarget, { recursive: true })
    cpSync(docsSourceDir, docsTarget, { recursive: true, force: true })
    docCount = countFiles(docsTarget)
    const added = gitRun(workDir, ['add', `docs/requirements/${reqId}`])
    if (!added.ok) return { ok: false, error: `归档文档失败：${added.error}` }
    const amend = gitRun(workDir, [...ID, 'commit', '--amend', '--no-edit'])
    if (!amend.ok) {
      // amend 失败（比如根本没有可提交的文档改动）就退一步单独提交，
      // 文档进没进仓库比「只留一个提交」重要。
      const extra = gitRun(workDir, [...ID, 'commit', '-q', '-m', `docs(${reqId}): 归档需求文档`])
      if (!extra.ok) return { ok: false, error: `归档文档提交失败：${extra.error}` }
      step('文档另起了一个提交（amend 不适用）')
    }
    step(`已归档 ${docCount} 个文档`)
  }

  const head = gitRun(workDir, ['rev-parse', 'HEAD']).out
  if (!head) return { ok: false, error: '合并后取不到提交号' }

  // 5. 推送。推不上去就是没人拿到合并结果，不能当成功过去——停下来说清楚，
  //    人重新推一次后回「继续」即可（那时 merge 已是 up-to-date，只补推送）。
  let pushed = gitRun(workDir, [...ID, 'push', '-q', 'origin', mainBranch])
  if (!pushed.ok) {
    // 沙箱外的进程偶尔也会撞上 Windows schannel 的凭据问题，换 openssl 再来一次
    pushed = gitRun(workDir, [...ID, '-c', 'http.sslBackend=openssl', 'push', '-q', 'origin', mainBranch])
  }
  if (!pushed.ok) {
    return { ok: false, error: `合并已在本地完成（${head.slice(0, 7)}），但推送失败：${pushed.error}。手动 push 后回「继续」` }
  }
  step(`已推送 ${mainBranch}`)

  // 6. 让裸仓库也知道新的主分支，下次建工作区才是最新起点
  if (repoDir) {
    gitRun(repoDir, ['fetch', '-q', workDir, `${mainBranch}:refs/remotes/origin/${mainBranch}`])
  }

  // 7. 变了哪些代码文件：合并提交相对第一父提交的差异，排掉文档部分
  const firstParent = gitRun(workDir, ['rev-parse', 'HEAD^1']).out ?? ''
  const changed = firstParent
    ? (gitRun(workDir, ['diff', '--name-only', '--diff-filter=ACMR', firstParent, head]).out ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('docs/requirements/'))
    : []

  const receipt = {
    status: 'done',
    summary:
      `已把 ${branch}（${featureSha.slice(0, 7)}）以 --no-ff 合并到 ${mainBranch}，` +
      `合并提交 ${head.slice(0, 7)}` +
      (docCount ? ` 同时归档 docs/requirements/${reqId}/ 共 ${docCount} 个文档` : '') +
      `，已 push 到 origin/${mainBranch}。无冲突。` +
      `合并由脚本完成（main 自分支切出后无新提交），未重跑编译与单元测试。`,
    artifacts: [
      ...changed.map((path) => ({ path, action: 'modified' })),
      ...(docCount ? [{ path: `docs/requirements/${reqId}/`, action: 'created' }] : []),
    ],
    selfCheck:
      `脚本化合并：提交开发工作区残留改动（如有）→ reset --hard origin/${mainBranch} → ` +
      `fetch ${branch} → merge --no-ff → 归档 ${docCount} 个文档并 amend 进合并提交 → push。`,
    decisions: [],
    blockers: [],
  }

  try {
    // 合并工作区是主分支的检出，docs/requirements/<reqId>/ 通常还不存在
    mkdirSync(reqDir, { recursive: true })
    writeFileSync(join(reqDir, receiptFile('merge')), JSON.stringify(receipt, null, 2))
  } catch (err) {
    return { ok: false, error: `回执写入失败：${String(err?.message ?? err)}` }
  }

  return { ok: true, receipt }
}
