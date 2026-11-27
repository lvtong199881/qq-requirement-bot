/**
 * 全链路测试的公共脚手架：起一个真的 bridge 进程，通过 App HTTP API 驱动它。
 *
 * 历史背景：这套测试原来靠 test/mock-onebot.js（手写的极简 OneBot 服务端）
 * 注入群消息。QQ 通道删掉之后那条路不存在了，改成直接打 App API——
 * 好处是顺手把「用户在 App 里点一下」这条真实路径也覆盖了，
 * 而原来的做法绕过了 API 层，等于测的是一个用户永远不会走的入口。
 *
 *   const b = await boot({ config: {...}, logPrefix: 'rerun' })
 *   await b.asAdmin()                            // 直接用预设管理员登进来
 *   await b.createThread('首页加个欢迎弹窗')
 *   b.logs()   b.child()   await b.stop()
 *
 * 注意：bridge 启动时会建一个预设管理员 admin / 123456，
 * 所以「注册一个新账号」拿到的是普通成员，不再是管理员。
 * 需要管理员就用 asAdmin()，需要普通成员就用 b.register(...)。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 本文件在 test/helpers/ 下，仓库根要上两级
export const ROOT = join(HERE, '..', '..')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 起 bridge，等 App API 就绪。
 *
 * api.port 固定写 0 让系统分配：本机可能正跑着一个占着 7881 的 bot，
 * 写死端口在开发机上会随机撞车。
 */
export async function boot({
  name = 'full',
  config = {},
  turnTimeoutMs = 240_000,
  extraRepos = [],
  heartbeat = false,
} = {}) {
  const tmp = mkdtempSync(join(tmpdir(), `qqrs-${name}-`))
  const project = join(tmp, 'project')
  mkdirSync(join(project, 'docs', 'requirements'), { recursive: true })

  // 状态目录必须挪进临时目录：这里会注册账号、建需求、落消息，
  // 共用仓库根的 .state/ 会把开发机上自己的用户表和会话搅乱
  // （第一次跑就踩到了：真实 users.json 里多出一个「测试管理员」）。
  const stateDir = join(tmp, '.state')

  const configPath = join(tmp, 'bot.config.json')
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        stateDir,
        repos: [{ id: 'app', name: 'test', path: project }, ...extraRepos],
        dshBin: 'dsh',
        profile: 'qqbot',
        bot: { name: '产品同学' },
        limits: { maxConcurrentTurns: 2, maxWorktrees: 4 },
        upload: { enabled: false, maxFiles: 4, maxFileMB: 20 },
        turnTimeoutMs,
        heartbeat: { enabled: heartbeat },
        api: { enabled: true, port: 0, host: '127.0.0.1' },
        panel: { enabled: false },
        verbose: true,
        ...config,
      },
      null,
      2,
    ),
  )

  const logs = []
  const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), `--config=${configPath}`], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const push = (d) => {
    const s = d.toString()
    logs.push(s)
    if (process.env.VERBOSE_CHILD) process.stdout.write('    ' + s.replace(/\n(?=.)/g, '\n    '))
  }
  child.stdout.on('data', push)
  child.stderr.on('data', (d) => push('[err] ' + d.toString()))

  const joined = () => logs.join('')
  // pred 允许返回 Promise：不少判据要打接口才知道（比如「消息流里有没有排队回执」）
  const waitFor = async (pred, timeoutMs = 20_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (await pred()) return true
      if (child.exitCode !== null) return false
      await sleep(100)
    }
    return false
  }

  // 端口从启动日志里捞：config 里写 0，实际端口由内核分配
  const ok = await waitFor(() => /App API：http:\/\/[\d.]+:\d+\/healthz/.test(joined()), 30_000)
  if (!ok) {
    throw new Error(`bridge 没起来，日志：\n${joined()}`)
  }
  const baseUrl = joined().match(/App API：(http:\/\/[\d.]+:\d+)\/healthz/)[1]

  let token = null

  /** 打一次 API，返回 { status, body } */
  const call = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let parsed = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  }

  const api = {
    baseUrl,
    tmp,
    project,
    configPath,
    stateDir,
    logs: joined,
    child,
    waitFor,
    call,

    async register(username = '测试管理员', password = 'pass1234', nickname) {
      const r = await call('POST', '/api/auth/register', { username, password, nickname })
      if (!r.body?.ok) throw new Error(`注册失败：${JSON.stringify(r.body)}`)
      token = r.body.token
      return r.body
    },
    /**
     * 用 bridge 启动时自动建的预设管理员登录。
     *
     * 它是「第一个账号」，所以是管理员——但它是系统建的，不是注册来的。
     * 测试里要管理员权限就走这里，别用 register（那会拿到普通成员）。
     */
    async asAdmin() {
      return api.login('admin', '123456')
    },
    async login(username = '测试管理员', password = 'pass1234') {
      const r = await call('POST', '/api/auth/login', { username, password })
      if (!r.body?.ok) throw new Error(`登录失败：${JSON.stringify(r.body)}`)
      token = r.body.token
      return r.body
    },
    /**
     * 建群 + 用「新需求」接口把需求提给某个仓库。
     *
     * App 里这是两步：先建群，再点底部「发起新需求」填表提交；群里 @ 一下已经
     * 不算提需求了。调用方只关心「拿到一个跑着需求的 threadId」，所以合成一步。
     */
    async createThread(text, { name, repoId = 'app' } = {}) {
      const group = await call('POST', '/api/threads', { name })
      if (!group.body?.ok) throw new Error(`建群失败：${JSON.stringify(group.body)}`)
      const said = await call('POST', '/api/requirements', { threadId: group.body.threadId, text, repoId })
      if (!said.body?.ok) throw new Error(`提需求失败：${JSON.stringify(said.body)}`)
      return group.body
    },
    async say(threadId, text, { mentions = [] } = {}) {
      const r = await call('POST', `/api/threads/${threadId}/messages`, { text, mentions })
      if (!r.body?.ok) throw new Error(`发言失败：${JSON.stringify(r.body)}`)
      return r.body
    },
    async messages(threadId, since = 0) {
      const r = await call('GET', `/api/threads/${threadId}/messages?since=${since}`)
      return r.body
    },
    async texts(threadId) {
      const page = await api.messages(threadId)
      return (page?.messages ?? []).map((m) => m.payload?.text ?? '')
    },

    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM')
      await sleep(400)
      if (child.exitCode === null) child.kill('SIGKILL')
    },
  }

  return api
}
