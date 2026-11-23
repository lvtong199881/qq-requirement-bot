/**
 * 发现通道发布器：把 {instanceId, urls} 写到一个稳定的发现地址。
 *
 * 为什么要有这条通道：免费版 trycloudflare 每次重启换域名，App 里
 * 写死的 baseUrl 断链后自己永远猜不出新地址。App 侧的 EndpointResolver
 * 拉这个 JSON 拿候选地址，逐个验证 instanceId + token 后静默换。
 *
 * 支持两种发布目标（按 rawUrl 形态自动选）：
 * 1. gitee contents API：https://gitee.com/<owner>/<repo>/api/content/master/endpoint.json
 *    —— 走 HTTP PUT，不用 git。为什么不用 gitee raw 页面：raw 的真实
 *    文件落在 raw.giteeusercontent.com，国内手机网络经常整个被重置；
 *    gitee.com 主站 + /api/v5 路径实测可达。
 * 2. git 仓库 raw：https://github.com/u/repo/raw/main/endpoint.json
 *    或 file://.../remote.git/raw/main/endpoint.json（测试用）
 *    —— clone → 覆盖 → commit + push。
 *
 * 失败只打日志不抛异常——发现通道挂了只影响「下次断链后能否自愈」，
 * 不影响服务本身。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 跑一条 git 命令，返回 {ok, stdout, stderr}。不抛异常。 */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 })
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 读一个 URL，返回 {ok, status, body}。30 秒超时，不抛异常。 */
async function httpGet(url, token) {
  try {
    const headers = { 'User-Agent': 'qq-requirement-bot' }
    if (token) headers.Authorization = `token ${token}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    return { ok: res.ok, status: res.status, body: await res.text() }
  } catch (err) {
    return { ok: false, status: 0, body: String(err?.cause?.message ?? err?.message ?? err) }
  }
}

/** Gitee contents API：读现有文件（拿 sha，更新时必填）。没有就返回 null。 */
async function giteeRead(apiBase, token) {
  const r = await httpGet(apiBase, token)
  if (!r.ok) return null
  try {
    const j = JSON.parse(r.body)
    if (j.encoding === 'base64' && typeof j.content === 'string' && j.sha) {
      return { sha: j.sha, content: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) }
    }
  } catch {
    // 内容不是合法 JSON / 不是 base64，当不存在处理
  }
  return null
}

/** Gitee contents API：创建（POST）或更新（PUT，带 sha）。 */
async function giteeWrite(apiBase, token, payloadJson, sha) {
  const body = {
    access_token: token,
    content: Buffer.from(payloadJson, 'utf8').toString('base64'),
    message: 'chore: 更新隧道地址',
    branch: 'master',
  }
  if (sha) body.sha = sha
  const res = await fetch(apiBase, {
    method: sha ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'qq-requirement-bot' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { ok: res.ok, status: res.status, body: await res.text() }
}

/** git 仓库路径：clone → 覆盖 → commit → push（原有逻辑抽出来）。 */
function publishViaGit({ repoUrl, branch, filePath, payloadJson, instanceId, old, log }) {
  let dir = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'endpoint-'))
    const clone = git(['clone', '--depth', '1', '--branch', branch, repoUrl, dir], null)
    if (!clone.ok) {
      log(`[discovery] clone 失败：${clone.stderr.trim().slice(0, 300)}`)
      return false
    }
    const oldPath = join(dir, filePath)
    // file:// 远端没法用 fetch peek，在这里补「没变就不推」的比对：
    // clone 下来的旧文件与要写的内容一致（instanceId + urls 都同）就算成功。
    if (!old) {
      try {
        const prev = JSON.parse(readFileSync(oldPath, 'utf8'))
        if (prev.instanceId && prev.instanceId === instanceId) {
          log('[discovery] 地址没变化，无需发布')
          return true
        }
      } catch {
        // 旧文件不存在或不是合法 JSON，正常发布
      }
    }
    writeFileSync(oldPath, payloadJson, 'utf8')
    const add = git(['add', filePath], dir)
    if (!add.ok) {
      log(`[discovery] git add 失败：${add.stderr.trim().slice(0, 300)}`)
      return false
    }
    const commit = git(
      ['-c', 'user.name=qq-bot', '-c', 'user.email=qq-bot@local', 'commit', '-m', 'chore: 更新隧道地址', filePath],
      dir,
    )
    if (!commit.ok) {
      log(`[discovery] commit 失败：${commit.stderr.trim().slice(0, 300)}`)
      return false
    }
    const push = git(['push', 'origin', branch], dir)
    if (!push.ok) {
      log(`[discovery] push 失败：${push.stderr.trim().slice(0, 300)}`)
      return false
    }
    return true
  } catch (err) {
    log(`[discovery] git 发布异常：${err?.message ?? err}`)
    return false
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 临时目录删不掉就算了，不影响主流程
      }
    }
  }
}

/**
 * 发布一份 endpoint.json。
 * @param {object} opts
 * @param {string} opts.rawUrl
 *   Gitee API 形态：https://gitee.com/<owner>/<repo>/api/content/master/endpoint.json
 *   git raw 形态：https://github.com/u/repo/raw/main/endpoint.json（或 gitee raw，能通的话）
 *   本地测试：file://C:/x/remote.git/raw/main/endpoint.json
 * @param {string} [opts.giteeToken]  gitee 私人令牌（Gitee API 形态必填）
 * @param {string} opts.instanceId  本机实例指纹（App 拿它确认新地址还是同一台后端）
 * @param {string[]} opts.urls   候选地址（新隧道域名优先，旧的垫底，≤3 个）
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<boolean>} 是否发布成功
 */
export async function publishEndpoint({ rawUrl, giteeToken, instanceId, urls, log = () => {} }) {
  if (!rawUrl) {
    log('[discovery] 没配 discovery.rawUrl，跳过发布')
    return false
  }
  const nextUrls = urls.slice(0, 3)
  const payloadJson = JSON.stringify(
    { instanceId, urls: nextUrls, updatedAt: new Date().toISOString() },
    null,
    2,
  ) + '\n'

  // —— Gitee contents API 形态 ——
  const apiM = rawUrl.match(/^https:\/\/gitee\.com\/[^/]+\/[^/]+\/api\/content\/([^/]+)\/(.+)$/)
  if (apiM) {
    if (!giteeToken) {
      log('[discovery] gitee API 形态需要配 discovery.giteeToken')
      return false
    }
    const [, branch, filePath] = apiM
    const repoPart = rawUrl.slice('https://gitee.com/'.length).split('/api/content/')[0]
    const apiBase = `https://gitee.com/api/v5/repos/${repoPart}/contents/${filePath}`
    const old = await giteeRead(`${apiBase}?ref=${branch}&access_token=${giteeToken}`)
    if (old && old.content.instanceId === instanceId && JSON.stringify(old.content.urls ?? []) === JSON.stringify(nextUrls)) {
      log('[discovery] 地址没变化，无需发布')
      return true
    }
    const w = await giteeWrite(apiBase, giteeToken, payloadJson, old?.sha)
    if (!w.ok) {
      log(`[discovery] gitee 发布失败 ${w.status}：${w.body.slice(0, 300)}`)
      return false
    }
    log(`[discovery] 已发布 ${nextUrls.join(', ')} → ${rawUrl}`)
    return true
  }

  // —— git raw 形态 ——
  const httpsM = rawUrl.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/raw\/([^/]+)\/(.+)$/)
  const fileM = httpsM ? null : rawUrl.match(/^(file:\/\/.+?)\/raw\/([^/]+)\/(.+)$/)
  const m = httpsM ?? fileM
  if (!m) {
    log(`[discovery] rawUrl 不是认识的形态，跳过：${rawUrl}`)
    return false
  }
  const [, repoBase, branch, filePath] = m
  const repoUrl = repoBase.startsWith('file://') ? repoBase : `${repoBase}.git`

  // 先读现网内容判断「没变就不推」。注意 fetch 不支持 file://，本地 bare
  // 远端（测试环境）peek 必然失败——这种情况跳过 peek，比对放到 clone 之后。
  let old = null
  if (!repoUrl.startsWith('file://')) {
    const peek = await httpGet(rawUrl)
    if (peek.ok) {
      try {
        old = JSON.parse(peek.body)
      } catch {
        // raw 内容不是合法 JSON（比如 gitee raw 被 403 页面顶替），当不存在
      }
    }
    if (old && old.instanceId === instanceId && JSON.stringify(old.urls) === JSON.stringify(nextUrls)) {
      log('[discovery] 地址没变化，无需发布')
      return true
    }
  }
  const ok = publishViaGit({ repoUrl, branch, filePath, payloadJson, instanceId, old, log })
  if (ok) log(`[discovery] 已发布 ${nextUrls.join(', ')} → ${rawUrl}`)
  return ok
}
