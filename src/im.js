#!/usr/bin/env node
/**
 * IM 独立入口：账号 + 群 + 消息 + 文件，就这些。
 *
 * 和 src/index.js 的区别：这个进程里没有 dsh、没有模型凭证、没有项目仓库、
 * 不会 spawn 任何东西。它只负责把人说的话存下来、把带 @ 的话丢进事件队列。
 * 需求引擎（src/engine.js）可以放在另一台有代码和 API key 的机器上，
 * 通过 /api/engine/* 连过来。
 *
 * 为什么要拆：不写需求的时候，IM 也该能用——群里发消息、看历史、传文件，
 * 全都不该依赖「模型凭证是否配好」「项目仓库是否 clone 完成」。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { loadConfig } from './config.js'
import { SessionStore } from './state.js'
import { UserStore, roleLabelOf } from './account/store.js'
import { MessageStore } from './store/messages.js'
import { ArtifactStore } from './store/artifacts.js'
import { MemberStore } from './store/members.js'
import { EngineEvents } from './im/events.js'
import { createThreadService } from './api/threads.js'
import { createEngineApi } from './api/engine.js'
import { createApiServer } from './api/server.js'
import { printQr } from './ui/qr.js'

/** 这台机器上手机大概能连到的 IPv4；0.0.0.0 监听时用来打印二维码。 */
function lanUrls(port) {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`)
    }
  }
  return out
}

const configPath = process.argv.find((a) => a.startsWith('--config='))?.slice(9)

let config
try {
  config = loadConfig(configPath)
} catch (err) {
  console.error(`[启动失败] ${err.message}`)
  process.exit(1)
}

const log = (...a) => console.log('[im]', ...a)

if (config.api?.enabled !== true) {
  console.error(
    '[启动失败] IM 要监听 App API，但 bot.config.json 里 api.enabled 不是 true。\n' +
      'IM 本身就要对外提供服务，这里不做「静默启动但没人连得上」的事。',
  )
  process.exit(1)
}

const store = new SessionStore(config.repoRoot, config.stateDir)
const stateDir = store.dir
const users = new UserStore(stateDir)
// 预设管理员先建，理由同 src/index.js：ensureBootstrap 只在空表时生效，
// 而下面 ensureBot 会往表里塞一个账号。
const boot = users.ensureBootstrap()
// 机器人账号先落表，消息库才知道 role=bot 的消息该挂在谁名下
const botUser = users.ensureBot({ nickname: config.bot?.name }).user
const messages = new MessageStore(join(stateDir, 'messages'), { bot: botUser })
const artifacts = new ArtifactStore(join(stateDir, 'artifacts'))
// 成员表也归 IM 管：它才是「谁能看见哪个群」的唯一裁判，
// 引擎那边不存成员关系，问权限一律回 IM 查。
const members = new MemberStore(join(stateDir, 'members'))
const events = new EngineEvents(join(stateDir, 'engine'))

/**
 * 引擎密钥。
 *
 * 优先用配置里的 api.engineToken；没配就生成一份落 .state 并打印出来——
 * 拆分部署的人第一步就得把这个值抄到引擎那边，藏在文件里只会让人去翻文档。
 * 已经生成过就不再打印，避免每次重启都把密钥刷进日志。
 */
function resolveEngineToken() {
  const fromConfig = String(config.api?.engineToken ?? '').trim()
  if (fromConfig) return { token: fromConfig, generated: false }

  const file = join(stateDir, 'engine-token')
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, 'utf8').trim()
      if (saved) return { token: saved, generated: false }
    }
  } catch {
    /* 读不到就当没有，下面重新生成 */
  }
  const token = randomBytes(24).toString('base64url')
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
  } catch (err) {
    log(`引擎密钥落盘失败：${err.message}（这次启动用临时密钥）`)
    return { token, generated: true }
  }
  return { token, generated: true }
}

const { token, generated } = resolveEngineToken()

const engineApi = createEngineApi({
  events,
  messages,
  artifacts,
  groups: store,
  users,
  members,
  token,
  log,
  botName: botUser.nickname,
})

/**
 * 权限裁决：用户表在 IM 这边，引擎每句话都回来问一次。
 *
 * 群内角色（群主/群管理员）是第二套身份，存在成员表里。两处都查：
 * 系统管理员在任何群都能提需求和拍板；群主/群管理员只在自己群里能。
 * 建群的人自动是群主，所以「谁建的群谁能提」不需要额外规则。
 */
const can = async (action, threadId, userId) => {
  const user = users.findById(userId)
  if (!user) return { ok: false, error: '没有这个用户' }
  const memberRole = threadId ? members.roleOf(threadId, userId) : null
  const r = users.can(action, user, memberRole)
  const roleLabel = roleLabelOf(user.role)
  return r.ok
    ? { ok: true, role: user.role, roleLabel }
    : { ok: false, error: r.error, role: user.role, roleLabel }
}

/**
 * 把消息交给引擎。
 *
 * 只入队，不直接跑：引擎可能在另一台机器上、可能没启动。事件落盘之后
 * 引擎什么时候连上都行，用户不会因为我先在了就把需求弄丢。
 */
const dispatch = async (ev) => {
  if (!engineApi.status().online) {
    // 引擎不在线时说清楚：不然用户 @ 完了看群里没动静，会以为消息没发出去
    try {
      messages.append(ev.threadId, {
        role: 'bot',
        kind: 'text',
        payload: { text: '需求引擎现在没连上。这条我先记下了，它连上之后会接着处理。' },
      })
    } catch {
      /* 存不下也不影响入队 */
    }
  }
  const { type, ...payload } = ev
  events.append(type, payload)
  return { ok: true }
}

const threads = createThreadService({
  store,
  messages,
  members,
  botUser,
  dispatch,
  can,
  log,
  botName: botUser.nickname,
})

const server = createApiServer({
  users,
  messages,
  artifacts,
  members,
  threadInfo: threads.threadInfo,
  listThreads: threads.listThreads,
  deliver: threads.deliver,
  createGroup: threads.createGroup,
  joinGroup: threads.joinGroup,
  renameGroup: threads.renameGroup,
  membersOf: threads.membersOf,
  setMemberRole: threads.setMemberRole,
  markRead: threads.markRead,
  engine: engineApi,
  botName: botUser.nickname,
  log,
  allowedOrigin: config.api.allowedOrigin ?? '',
})

server.once('error', (err) => {
  console.error(`[启动失败] App API 起不来（端口 ${config.api.port}）：${err.message}`)
  process.exit(1)
})

server.listen(config.api.port, config.api.host, () => {
  const { port, address } = server.address()
  const urls = config.api.publicUrl
    ? [config.api.publicUrl]
    : address === '0.0.0.0' || address === '::'
      ? lanUrls(port)
      : [`http://${address}:${port}`]
  const base = urls[0] ?? `http://${address}:${port}`

  log(`IM 已启动：${base}/healthz`)
  log(`引擎通道：${base}/api/engine/inbox（长轮询，游标从 0 开始即可）`)
  if (generated) {
    log(`引擎密钥（抄到引擎配置的 im.token）：${token}`)
    log(`已存到 ${join(stateDir, 'engine-token')}，以后不再打印`)
  }
  for (const url of urls.slice(0, 3)) printQr(url)

  // 启动时已经建过（见 store 初始化那段，必须在 ensureBot 之前），这里只播报
  if (boot.created) {
    log(`已创建预设管理员：${boot.user.username} / 123456`)
    log('这个密码是公开的，登录后请立刻在「账号管理」里改掉')
  } else if (users.needsFirstAdmin()) {
    log('用户表里有账号但没有可用的管理员——预设账号只在空表时创建')
    log('删掉 .state/users.json 重启可以回到初始状态（数据会丢）')
  }
})

const shutdown = () => {
  log('正在退出…')
  // 挂着长轮询的引擎会一直等，这里主动放掉，别让它们以为服务还活着
  try {
    events.close()
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0))
  // 有连接一直不断的话别永远挂着
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
