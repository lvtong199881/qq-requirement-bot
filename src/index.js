#!/usr/bin/env node
/**
 * 入口：连接 OneBot，把群里 @产品同学 的消息变成一回合 dsh headless。
 *
 * 消息流：
 *   QQ 群 → NapCat → WebSocket → 这里 → spawn dsh → 解析 NDJSON
 *   → 分条推送回群 → 检测 [[WAITING]] → 保存 sessionId 等下一次 @
 */
import { loadConfig, resolveModelEnv } from './config.js'
import { OneBot } from './onebot.js'
import { runTurn } from './runner.js'
import { parseGate, gateInstructions } from './protocol.js'
import { sanitize, RateLimiter, sleep, runningText, formatDuration } from './format.js'
import { Runtime } from './runtime.js'
import { resolveStageStart, ackFor, planStageAnnounce } from './stage.js'
import { InstanceRegistry, isAlive } from './instances.js'
import { createBridgeServer } from './server.js'
import { join as pathJoin } from 'node:path'
import {
  snapshot,
  diffSnapshot,
  uploadName,
  touchedReqIds,
  currentStage,
  stageTable,
  guessStageStart,
} from './artifacts.js'
import {
  parseCommand,
  helpText,
  releaseConfirmText,
  deniedText,
  COMMANDS,
} from './commands.js'
import {
  classifyMessage,
  isAmbiguous,
  anchorBlock,
  routedPrompt,
  ambiguousReply,
  INTENT,
} from './router.js'
import { SessionStore, GroupStateMachine, STATES } from './state.js'
import { existsSync, readdirSync, statSync } from 'node:fs'

const configPath = process.argv.find((a) => a.startsWith('--config='))?.slice(9)
const isDryRun = process.argv.includes('--dry-run')

let config
try {
  config = loadConfig(configPath)
} catch (err) {
  console.error(`[启动失败] ${err.message}`)
  process.exit(1)
}

// 模型凭证：dsh 的 llm-pi-ai 按 provider 的 apiKeyEnv 读环境变量，
// 所以启动时把所有可能用到的 key 一并备好，缺哪个由 provider 自己报错。
const modelEnv = resolveModelEnv()
if (!Object.keys(modelEnv).length) {
  console.error(
    '[启动失败] 找不到任何模型凭证。\n' +
      '请在 ~/.dsh/.credentials.yaml 的 refs 段写 DEEPSEEK_API_KEY 或 OPENCODE_GO_API_KEY，\n' +
      '或直接 export 对应环境变量。',
  )
  process.exit(1)
}

const store = new SessionStore(config.repoRoot)
const machine = new GroupStateMachine(config, store)
const limiter = new RateLimiter(config.limits.maxMessagesPerMinute)
const bot = new OneBot(config.onebot)

// 运行时状态中心：日志、回合、资源都从这里出去（面板 /api/status 的数据源）
const runtime = new Runtime({
  logDir: pathJoin(config.repoRoot, '.logs'),
  verbose: config.verbose,
})
const log = (...a) => runtime.info(...a)
const detail = (...a) => config.verbose && runtime.log('debug', ...a)

log(`配置就绪：skill=${config.skillDir}`)
log(`项目目录：${config.projectDir}`)
log(`群策略：${config.groupPolicy.mode}${config.groupPolicy.mode === 'auto' ? '（拉进哪个群就服务哪个群）' : ''}`)

/** 群成员角色缓存：`groupId:userId` → {role, at}。群管判定每条消息都要，缓存 5 分钟 */
const memberRoles = new Map()
const ROLE_TTL_MS = 5 * 60 * 1000

async function memberRole(groupId, userId) {
  if (!userId) return null
  const key = `${groupId}:${userId}`
  const hit = memberRoles.get(key)
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.role
  const role = await bot.getMemberRole(groupId, userId)
  if (role) memberRoles.set(key, { role, at: Date.now() })
  return role
}

/**
 * 谁能驱动 bot：
 *   1. superAdmin —— 不受任何限制，任何群都可以（只能改配置文件）
 *   2. 群主 / 群管理员 —— 在本群内可以
 *   3. adminUsers 白名单 —— 额外放行（面板可编辑）
 */
async function canOperate(groupId, userId) {
  const uid = String(userId ?? '')
  if (config.superAdmin.includes(uid)) return { ok: true, role: 'superadmin' }
  const role = await memberRole(groupId, uid)
  if (role === 'owner' || role === 'admin') return { ok: true, role }
  if (config.adminUsers.includes(uid)) return { ok: true, role: role ?? 'listed' }
  return { ok: false, role }
}

/** 运行期发现的群：群号 → {name, memberCount}，用于日志和「本群」查询 */
const knownGroups = new Map()

// ────────────────────────────── 发消息 ──────────────────────────────

/**
 * 构造一条「引用回复」消息段。
 * @param {number|string} messageId 被引用的消息 id
 * @returns {object|null}
 */
function replySegment(messageId) {
  if (!messageId) return null
  return { type: 'reply', data: { id: String(messageId) } }
}

/**
 * 发消息。replyTo 有值时以「引用回复」形式发出，跟真人回消息一样。
 * @param {string} groupId
 * @param {string} text 纯文本
 * @param {{replyTo?: number|string}} [opts]
 */
// 长任务阶段进展的最小间隔：够久才不会刷屏，够短才不会让人干等
// 距上次「群里收到消息」的时间——agent 内部活动不算，只由 sendText 成功发送后刷新。
// 模块级：sendText 与各群的心跳共用（bridge 当前只服务少数群，共享一个计时够用）。
let lastActivityAt = Date.now()

async function sendText(groupId, text, { replyTo } = {}) {
  const wait = limiter.delayFor()
  if (wait > 0) await sleep(wait)

  const seg = replySegment(replyTo)
  const message = seg ? [seg, { type: 'text', data: { text } }] : text

  try {
    await bot.sendGroupMsg(groupId, message)
    lastActivityAt = Date.now() // 群里收到消息了，心跳重新计时
  } catch (err) {
    log(`发送失败（${groupId}）：${err.message}`)
  }
}

async function sendPlain(groupId, text, { replyTo } = {}) {
  await sendText(groupId, text, { replyTo })
}

// ────────────────────────────── 一回合 ──────────────────────────────

/** 消息 1 的发送壳：文案来自 stage.js 的 ackFor（纯函数，可单测） */
async function sendAck(groupId, st, replyTo, intent) {
  const ack = ackFor(st, intent)

  // 绑定丢了就从编排记录找回并落盘——否则下次会去读「最近改动的那个需求」，
  // 项目里并存多个需求时可能读错。
  if (ack.reqIdToBind) {
    store.save(groupId, { ...st, reqId: ack.reqIdToBind })
    log(`[${groupId}] 绑定自愈（回执）：reqId=${ack.reqIdToBind}`)
  }

  await sendPlain(groupId, ack.text, { replyTo })
}

// ─────────────────── 群消息播报（四类，全部由 bridge 生成）───────────────────
// 用户明确要求：agent 的文字一律不进群，群里只出现状态播报。
//   1. 用户发消息后的回执：当前XX阶段中，已进行 X小时X分钟X秒
//   2. 阶段播报：XX阶段已开始 / XX阶段已完成（附产物）
//      例外：回合以「等用户拍板」结束时，agent 的最终答复段会一并发出——
//      那段是结论与选项，不发给群里就只剩一句「等你确认」，用户不知道确认什么。
//   3. 心跳：当前XX阶段中，已进行 X小时X分钟X秒
//   4. 异常：XX阶段异常，请联系bot管理员，异常原因如下：…

/** 把毫秒差格式化成「12 分钟」 */
/**
 * 同步阶段状态并生成要播报的消息。
 * 阶段真值来自编排记录的「阶段进度」表，不看 agent 说了什么。
 *
 * @param {object} st 群状态
 * @returns {{messages: string[], running: string|null, finishedNow: string[], patch: object}}
 */

/** 消息 1：用户发消息后的回执 */

async function handleTurn(groupId, userText, { isContinuation, replyTo, anchor, promptBody, intent, retried = false }) {
  const st = machine.peek(groupId)
  if (!st) return

  const aborter = new AbortController()
  const release = machine.acquire(groupId, aborter)
  if (!release) {
    // 消息排队等下一轮，不再额外播报——回执已经告诉用户当前状态了，
    // 多说一句「上一个回合还在跑」只是泄露内部机制。
    machine.enqueue(groupId, userText)
    return
  }

  const started = Date.now()
  runtime.beginTurn(groupId)
  const before = snapshot(st.projectDir)
  let pendingText = ''
  let turnDone = false // runTurn 是否已 resolve

  // 消息 3：心跳——只要群里「距上次发言」够久就补一条状态。
  // 默认 5 分钟，可配 heartbeat.idleMinutes。话术固定，不含任何 agent 内容。
  const idleMs = (config.heartbeat?.idleMinutes ?? 5) * 60_000
  const heartbeat = setInterval(() => {
    if (config.heartbeat?.enabled === false) return
    if (Date.now() - lastActivityAt < idleMs) return
    // 只在有进行中阶段时发（阶段都完成了就没必要报心跳）
    const { stages } = stageTable(st.projectDir, st.reqId ?? undefined)
    const running = stages.find((x) => x.status.includes('进行中'))
    if (!running) return
    lastActivityAt = Date.now()
    sendPlain(groupId, runningText(running.name, resolveStageStart(st, running.name))).catch(() => {})
  }, 60_000)

  const persist = (patch) => {
    store.save(groupId, { ...st, ...patch, lastActiveAt: Date.now() })
  }
  persist({ status: STATES.RUNNING })

  log(`[${groupId}] 回合开始${isContinuation ? '（续跑）' : '（新会话）'}：${userText.slice(0, 60)}`)

  try {
    // 协议只在首轮注入；锚点每回合都注入（防走偏第 3 层）；
    // 消息内容由路由层给出的确定性骨架承载（第 2 层）。
    const parts = []
    if (!isContinuation) {
      parts.push(gateInstructions({ botName: config.bot.name, approval: st.approval }))
    }
    if (anchor) parts.push(anchor)
    if (promptBody) parts.push(promptBody)
    const prompt = parts.join('\n\n---\n\n')

    const result = await runTurn({
      dshBin: config.dshBin,
      profile: config.profile,
      projectDir: st.projectDir,
      sessionId: isContinuation ? st.sessionId : undefined,
      prompt,
      env: { ...process.env, ...modelEnv },
      timeoutMs: config.turnTimeoutMs,
      signal: aborter.signal,
      onChild: (child) => {
        // 把子进程 pid 交给面板展示（判断「agent 到底活着没有」）
        runtime.beginTurn(groupId, { childPid: child.pid })
        child.on('close', () => {
          if (!turnDone) {
            log(`[${groupId}] 子进程提前退出`)
            clearInterval(heartbeat)
          }
        })
      },
      onEvent: (ev) => {
        runtime.noteEvent(groupId)
        if (ev.type === 'status' && ev.phase === 'turn_start') {
          detail('turn_start')
        }
        // agent 的任何文字都不进群——群里只发 bridge 生成的
        // 四类状态消息（用户回执 / 阶段播报 / 心跳 / 异常）。
        // agent 的 text 只留作最终结论的兜底。
        if (ev.type === 'text' && typeof ev.text === 'string') {
          pendingText += ev.text
        }
      },
    })

    turnDone = true
    const gate = parseGate(result.finalText || pendingText)

    // agent 的文字不再进群（用户要求：只有四类 bridge 状态消息）。
    // gate.cleaned 仅用于判断阶段结论与等待事项，不直接发送。

    // 异常收尾
    // session 被上一个没退出的 dsh 进程锁住：清掉 sessionId，立刻用新会话重跑一次。
    // 不这么做的话，这个群之后每条消息都会失败（真实踩过：429 打断后进程挂住不释放锁）。
    if (result.sessionLocked && !retried) {
      log(`[${groupId}] session 写锁被占用，清空 sessionId 后用新会话重试`)
      persist({ sessionId: null, status: STATES.IDLE })
      await sendPlain(groupId, '上一个进程没释放会话，已重置并重新开始这一轮。', { replyTo })
      setTimeout(() => {
        handleTurn(groupId, userText, {
          isContinuation: false,
          replyTo,
          anchor,
          promptBody,
          intent,
          retried: true,
        }).catch((e) => log(`重试失败：${e.message}`))
      }, 500)
      return
    }

    // 消息 4：异常播报（固定格式，方便用户/管理员一眼定位）
    const stageName = (planStageAnnounce({ ...st, reqId: st.reqId }).running) ?? st.stage ?? '当前'
    const abnormal = (reason) => {
      const plain = String(reason ?? '（无详细信息）')
      log(`[${groupId}] 异常播报：${plain.replace(/\n/g, ' / ').slice(0, 200)}`)
      return sendPlain(groupId, `${stageName}阶段异常，请联系 bot 管理员，异常原因如下：\n${plain}`, {
        replyTo,
      })
    }

    if (result.errorSummary) {
      await abnormal(result.errorSummary)
    } else if (result.timedOut) {
      await abnormal(`回合超时（超过 ${Math.round(config.turnTimeoutMs / 60000)} 分钟），已强制停止。`)
    } else if (result.exitCode !== 0 && !gate.cleaned) {
      const tail = (result.stderr || '').split('\n').filter(Boolean).slice(-3).join('\n')
      await abnormal(`进程退出码 ${result.exitCode}。\n${sanitize(tail).slice(0, 400)}`)
    }

    // 产物回传
    let uploadedNames = []
    if (config.upload.enabled) {
      const after = snapshot(st.projectDir)
      const all = diffSnapshot(before, after, config.upload)

      // ── 第 4 层：输出审计 ──
      // 绑定需求之外的 docs/requirements 目录被改动 = agent 越界。
      // 产物不回传群里，发警告。编排记录不自动回滚（动产物太危险），交人判断。
      const boundReqId = st.reqId
      const violated = boundReqId
        ? touchedReqIds(before, after).filter((id) => id !== boundReqId)
        : []
      const allWrite = touchedReqIds(before, after)
      const inBound = allWrite.filter((id) => id === boundReqId)

      const changed = all.filter((f) =>
        boundReqId
          ? inBound.some((id) => f.path.includes(`/docs/requirements/${id}/`)) ||
            !f.path.includes('/docs/requirements/')
          : true,
      )
      const failed = []

      if (violated.length) {
        log(`[${groupId}] ⚠️ 越界写入检测：${violated.join(', ')}（绑定=${boundReqId}）`)
        await sendPlain(
          groupId,
          `⚠️ 越界警告：这一回合动了绑定需求（${boundReqId}）之外的目录：${violated.join('、')}。` +
            `相关文件我不会发到群里。如果不是你有意安排，回复「停」然后告诉我。`,
          { replyTo },
        )
      }
      for (const f of changed) {
        if (!existsSync(f.path)) continue
        try {
          await bot.uploadGroupFile(groupId, f.path, uploadName(st.projectDir, f.path))
          await sleep(300)
        } catch (err) {
          log(`上传失败 ${f.path}: ${err.message}`)
          failed.push(f.path)
        }
      }
      // 失败汇总成一条，不要每个文件刷一行
      if (failed.length) {
        await sendPlain(
          groupId,
          `${failed.length} 个产物上传失败，文件已在项目里：\n` +
            failed.map((f) => '· ' + f.replace(st.projectDir + '/', '')).join('\n'),
        )
      }
      if (changed.length) {
        uploadedNames = changed.map((f) => f.path.split('/').pop()).filter(Boolean)
        detail(`回传 ${changed.length} 个产物`)
      }
    }

    // ── 消息 2：阶段播报（回合收尾的最后一步）──
    // 话术由 bridge 生成，不含任何 agent 文字。
    const stageInfo2 = currentStage(st.projectDir)
    const reqIdToBind2 = st.reqId || stageInfo2.reqId
    const planned = planStageAnnounce({ ...st, reqId: reqIdToBind2 })

    // ── 要用户拍板时发什么 ──
    // 首选 [[ASK]] 段：agent 按要求把「具体要判断什么」写在标记后面，bridge 负责拼接。
    // 没写 ASK 时退回整段答复（兜底，不至于又只剩一句「等你确认」）。
    let finalAnswer = ''
    if (gate.state === 'waiting' || gate.state === 'done') {
      finalAnswer = (gate.ask || '').trim() || (gate.cleaned || '').trim()
    }

    const pendingNote = gate.state === 'waiting' && gate.label ? `等你确认：${gate.label}` : ''

    const lines = []
    for (const msg of planned.messages) {
      if (msg.endsWith('阶段已完成。')) {
        const parts = [msg]
        if (uploadedNames.length) parts.push(`产物：${uploadedNames.join('、')}`)
        // 有最终答复时不再重复 waitingLabel——答复里已经把选项写清楚了
        if (!finalAnswer && pendingNote) parts.push(pendingNote)
        lines.push(parts.join('\n'))
      } else {
        lines.push(msg)
      }
    }

    // 要用户拍板的内容，前面明确写「需要决策：」，让人一眼知道这段是等他决定的
    if (finalAnswer) {
      const MAX = 1800
      const body =
        finalAnswer.length > MAX
          ? `${finalAnswer.slice(0, MAX)}\n……（还有 ${finalAnswer.length - MAX} 字，完整内容见需求文档）`
          : finalAnswer
      lines.push(`需要决策：\n${body}`)
    } else if (!lines.length && pendingNote) {
      // agent 没给正文时才用 waitingLabel 兜底
      lines.push(pendingNote)
    }
    if (!lines.length && gate.state === 'done') lines.push('这个需求跑完了。要新需求直接 @我 说。')

    const nextStatus =
      gate.state === 'waiting' ? STATES.WAITING : gate.state === 'done' ? STATES.IDLE : STATES.WAITING

    persist({
      sessionId: result.sessionId ?? st.sessionId,
      status: nextStatus,
      waitingLabel: gate.state === 'waiting' ? gate.label : '',
      reqId: reqIdToBind2,
      turn: st.turn + 1,
      projectDir: st.projectDir,
      ...planned.patch,
    })
    for (const line of lines) {
      await sendPlain(groupId, line, { replyTo })
    }



    log(`[${groupId}] 回合结束：${((Date.now() - started) / 1000).toFixed(1)}s，状态=${nextStatus}`)
  } catch (err) {
    log(`[${groupId}] 回合异常：${err.message}`)
    const stageName = currentStage(st.projectDir).stage ?? '当前'
    await sendPlain(
      groupId,
      `${stageName}阶段异常，请联系 bot 管理员，异常原因如下：\n${err.message}`,
    ).catch(() => {})
    persist({ status: STATES.WAITING })
  } finally {
    clearInterval(heartbeat)
    runtime.endTurn(groupId)
    release()
    // 处理排队消息
    const queued = machine.drainQueue(groupId)
    if (queued.length) {
      const next = queued.join('\n')
      const cur = machine.peek(groupId)
      handleTurn(groupId, next, { isContinuation: !!cur?.sessionId }).catch((e) =>
        log(`排队回合失败：${e.message}`),
      )
    }
  }
}

// ────────────────────────────── 事件路由 ──────────────────────────────

/** 从 OneBot 消息段里取纯文本 */
function extractText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message
    .filter((seg) => seg.type === 'text')
    .map((seg) => seg.data?.text ?? '')
    .join('')
}

/** 是否 @ 了本 bot */
function isAtMe(message, selfId) {
  if (!Array.isArray(message)) return false
  return message.some((seg) => seg.type === 'at' && String(seg.data?.qq) === String(selfId))
}

/** 去掉 @段，只留正文 */
function stripAt(message) {
  if (!Array.isArray(message)) return String(message ?? '')
  return message
    .filter((seg) => seg.type !== 'at')
    .map((seg) => (seg.type === 'text' ? seg.data?.text ?? '' : ''))
    .join('')
    .trim()
}

const STOP_WORDS = new Set(['停', '停止', '中断', '停一下', '取消'])
const HELP_WORDS = new Set(['帮助', 'help', '?', '？', '怎么用'])

// bot 的 QQ 真实昵称（get_login_info 拿），和配置里的自称 bot.name 是两回事
let botNickname = null

bot.on('connected', async () => {
  // 拉 bot 自己的 QQ 资料：面板要显示真实昵称，而不是配置里的自称
  const login = await bot.getLoginInfo()
  if (login?.nickname) {
    botNickname = login.nickname
    detail(`bot 真实昵称：${botNickname}`)
  }
  log(`已连接 OneBot：${config.onebot.ws}（bot=${config.bot.name} / ${botNickname ?? '昵称未知'}）`)
  // 连上就拉一次群列表：群号由 bot 自己报，配置里不用填
  try {
    const list = await bot.call('get_group_list', {}, 8000)
    if (Array.isArray(list) && list.length) {
      for (const g of list) {
        knownGroups.set(String(g.group_id), { name: g.group_name, memberCount: g.member_count })
      }
      const excluded = config.excludeGroups ?? []
      const usable = list.filter((g) => !excluded.includes(String(g.group_id)))
      log(`bot 已在 ${list.length} 个群里，服务其中 ${usable.length} 个：`)
      for (const g of list) {
        const skip = excluded.includes(String(g.group_id))
        log(`  ${skip ? '· [已排除]' : '·'} ${g.group_name}（${g.group_id}）`)
      }
      if (excluded.length) log(`排除名单：${excluded.join(', ')}（写在 bot.config.json 的 excludeGroups）`)
    } else {
      log('bot 还不在任何群里，把它拉进群后 @ 它就行。')
    }
  } catch (err) {
    log(`拉取群列表失败（不影响使用，收到消息时会自动识别）：${err.message}`)
  }
})

bot.on('disconnected', () => {
  log('OneBot 断开，自动重连中…')
})

// 连接失败给明确诊断，并做节流，避免重连时空刷屏
let lastDiagAt = 0
let diagHints = 0
bot.on('connection-error', (info) => {
  // 探测阶段先不打印，等结论出来
  if (info.probing) return

  const now = Date.now()
  if (now - lastDiagAt < 10000) return
  lastDiagAt = now

  log(`连不上 OneBot（第 ${info.failures} 次）：${info.reason ?? '未知原因'}`)
  if (diagHints++ === 0) {
    log(
      'NapCat 侧要开「WebSocket 服务端」：设置 → 网络配置 → 新建 WS 服务端，' +
        '端口与 onebot.ws 一致；有 token 就填到 onebot.token。',
    )
  }
})

/** 群里第一次见到这个名字时补登记，让日志和「本群」能显示群名 */
async function ensureGroupInfo(groupId) {
  if (knownGroups.has(groupId)) return knownGroups.get(groupId)
  try {
    const info = await bot.call('get_group_info', { group_id: Number(groupId), no_cache: false }, 5000)
    if (info?.group_id) {
      const v = { name: info.group_name, memberCount: info.member_count }
      knownGroups.set(groupId, v)
      log(`发现新群：${info.group_name}（${groupId}）`)
      return v
    }
  } catch {
    /* 拿不到就用作匿名群，不影响功能 */
  }
  knownGroups.set(groupId, { name: `群${groupId}`, memberCount: 0 })
  return knownGroups.get(groupId)
}

bot.on('message', async (frame) => {
  if (frame.message_type !== 'group') return
  const groupId = String(frame.group_id)

  // 群策略判定：auto 模式下这里永远放行，不需要预先填群号
  const resolved = machine.resolveGroup(groupId)
  if (!resolved.ok) {
    detail(`忽略群 ${groupId}：${resolved.reason}`)
    return
  }
  const st = machine.peek(groupId)
  if (!st) return

  // 只响应 @ 本 bot
  if (!isAtMe(frame.message, frame.self_id ?? bot.selfId)) return

  await ensureGroupInfo(groupId)

  // ── 权限闸门：只服务群主/群管理员，其他人的 @ 一律静默忽略 ──
  // 静默是有意的：群成员发消息时 bot 不做任何回应，避免刷屏和误触发。
  const speaker = frame.sender ?? {}
  const speakerId = String(speaker.user_id ?? frame.user_id ?? '')
  const gatePerm = await canOperate(groupId, speakerId)
  if (!gatePerm.ok) {
    detail(`忽略 ${speakerId}（角色=${gatePerm.role ?? '未知'}）在群 ${groupId} 的消息`)
    return
  }

  // 回复时引用用户这条消息，比 @ 自己更像真人
  const replyTo = frame.message_id
  let text = stripAt(frame.message)

  // 记录发起人（面板列表要显示「谁提的需求」）
  const sender = speaker
  const initiator = {
    userId: String(sender.user_id ?? frame.user_id ?? ''),
    nickname: sender.card || sender.nickname || String(sender.user_id ?? ''),
    at: Date.now(),
  }
  if (initiator.userId && st.initiator?.userId !== initiator.userId) {
    st.initiator = initiator
    store.save(groupId, { ...st, initiator })
  } else if (initiator.userId && !st.initiator) {
    st.initiator = initiator
    store.save(groupId, { ...st, initiator })
  }
  log(`[${groupId}] 收到：${text.slice(0, 80)}`)

  // ── /指令（白名单）────────────────────────────────────────────
  const cmd = parseCommand(text)
  if (cmd) {
    // 入口已经保证是群主/群管理员；这里再区分 owner 级与群管级
    const isAdmin =
      gatePerm.role === 'superadmin' ||
      gatePerm.role === 'owner' ||
      config.adminUsers.includes(initiator.userId)

    if (cmd.unknown || !cmd.def) {
      await sendPlain(groupId, `没有 /${cmd.name} 这条指令。发 /help 看可用的。`, { replyTo })
      return
    }

    if (cmd.def.scope === 'admin' && !isAdmin) {
      await sendPlain(groupId, deniedText(cmd.name), { replyTo })
      return
    }

    if (cmd.name === 'help') {
      const { stages } = stageTable(st.projectDir, st.reqId ?? undefined)
      const running = stages.find((x) => x.status.includes('进行中'))
      const statusLine = running
        ? `当前状态：${running.name}阶段中，已进行 ${formatDuration(Date.now() - (st.stageStartedAt || Date.now()))}。`
        : st.waitingLabel
          ? `当前状态：${st.waitingLabel}`
          : '当前状态：没有进行中的任务。'
      await sendPlain(groupId, helpText({ isAdmin, statusLine }), { replyTo })
      return
    }

    if (cmd.name === 'stop') {
      const killed = machine.interrupt(groupId)
      await sendPlain(groupId, killed ? '已停止当前任务。' : '当前没有在跑的任务。', { replyTo })
      return
    }

    if (cmd.name === 'resume') {
      // 走到下面的 CONTINUE 流程，只是把用户原文换成人话
      text = '继续'
    }

    if (cmd.name === 'release') {
      // 二次确认：先记下意图，等用户回「确认」
      if (st.pendingRelease) {
        await sendPlain(groupId, '已经在等你确认了，回「确认」执行，回别的取消。', { replyTo })
        return
      }
      const { stages } = stageTable(st.projectDir, st.reqId ?? undefined)
      const running = stages.find((x) => x.status.includes('进行中'))
      st.pendingRelease = { at: Date.now(), by: initiator.userId }
      store.save(groupId, { ...st, pendingRelease: st.pendingRelease })
      await sendPlain(groupId, releaseConfirmText({ reqId: st.reqId, stage: running?.name }), { replyTo })
      return
    }
  }

  // ── /release 的二次确认回复 ──────────────────────────────────
  if (st.pendingRelease) {
    const yes = /^(确认|是|yes|y|ok|好)$/i.test(text.trim())
    st.pendingRelease = null
    store.save(groupId, { ...st, pendingRelease: null })
    if (!yes) {
      await sendPlain(groupId, '已取消释放。', { replyTo })
      return
    }
    const killed = machine.interrupt(groupId)
    await sleep(600) // 给子进程一点时间收尾，避免 session 写锁残留
    store.clear(groupId)
    runtime.endTurn(groupId)
    log(`[${groupId}] 已释放会话与进程（被打断的回合：${killed ? '有' : '无'}）`)
    await sendPlain(
      groupId,
      `已释放${killed ? '（当前回合已打断）' : ''}。进度都在编排记录里，重新发需求或「继续」就能接上。`,
      { replyTo },
    )
    return
  }

  // ── 打回后等用户补充修改意见 ──────────────────────────────────
  if (st.pendingReject) {
    const t = text.trim()
    const cancel = /^(取消|算了|不打了|不改了)$/.test(t)
    const target = st.pendingReject
    st.pendingReject = null
    store.save(groupId, { ...st, pendingReject: null })
    if (cancel) {
      await sendPlain(groupId, '已取消打回，阶段保持原样。', { replyTo })
      return
    }
    // 把这条当成修改意见，走 REJECT 流程
    const rejected = {
      intent: INTENT.REJECT,
      detail: t,
    }
    await sendAck(groupId, st, replyTo, INTENT.REJECT)
    const anchorText = st.reqId
      ? anchorBlock({
          reqId: st.reqId,
          projectDir: st.projectDir,
          stage: target.stage,
          envHints: config.envHints,
        })
      : ''
    const promptBody = routedPrompt({
      intent: INTENT.REJECT,
      userText: t,
      bind: {
        reqId: st.reqId,
        stage: target.stage,
        waitingLabel: st.waitingLabel,
        rejectReason: t,
      },
    })
    handleTurn(groupId, t, {
      isContinuation: !!st.sessionId && st.status !== STATES.IDLE,
      replyTo,
      anchor: anchorText,
      promptBody,
      intent: rejected.intent,
    }).catch((e) => log(`回合启动失败：${e.message}`))
    return
  }

  // ── 意图路由：bridge 决定每条消息是什么，agent 不猜 ──
  const { intent, detail: intentDetail } = classifyMessage(text)

  // 停：不打断 agent，直接杀回合
  if (intent === INTENT.STOP) {
    const killed = machine.interrupt(groupId)
    await sendPlain(groupId, killed ? '已打断当前回合。' : '当前没有在跑的回合。', { replyTo })
    return
  }

  if (intent === INTENT.HELP) {
    await sendPlain(
      groupId,
      [
        `我是${config.bot.name}，在这个群里帮你跑完整需求流程。`,
        '',
        '直接 @我 说需求，比如：',
        '  首页加个欢迎弹窗，手动批准',
        '',
        '其他指令：',
        '  @我 通过 / 提修改意见  → 放行或打回当前阶段',
        '  @我 继续              → 上一轮没收敛时接着跑',
        '  @我 停                → 打断当前回合',
        '  @我 新需求 <描述>      → 结束当前需求，开新的',
        '  @我 本群              → 看当前需求绑定与进度',
      ].join('\n'),
      { replyTo },
    )
    return
  }

  if (intent === INTENT.INFO) {
    const info = knownGroups.get(groupId)
    const { stage } = currentStage(st.projectDir)
    await sendPlain(
      groupId,
      [
        `群号：${groupId}`,
        `群名：${info?.name ?? '未知'}`,
        `绑定需求：${st.reqId ?? '（还没有）'}`,
        `当前阶段：${stage ?? '未知'}`,
        st.waitingLabel ? `正在等：${st.waitingLabel}` : null,
        `项目目录：${st.projectDir}`,
        `批准模式：${st.approval === 'manual' ? '手动批准' : '自动推进'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      { replyTo },
    )
    return
  }

  // 新需求：显式换绑。带描述就受理新需求，不带描述就清绑定
  if (intent === INTENT.NEW_REQ) {
    if (!intentDetail) {
      store.clear(groupId)
      await sendPlain(groupId, '已清空。下一条消息发新需求，我来绑定。', { replyTo })
      return
    }
    // 带描述：清掉旧绑定，把描述作为新需求受理（回合结束后绑定新 reqId）
    store.clear(groupId)
    st.reqId = null
    st.sessionId = null
    st.status = STATES.IDLE
  }

  // 空消息
  if (!text.trim()) {
    await sendPlain(groupId, `我在。直接说要做什么就行。发「帮助」看完整说明。`, { replyTo })
    return
  }

  // 打回但没给修改意见：先追问，别让 agent 拿着一个「打回」二字去瞎改
  if (intent === INTENT.REJECT && !intentDetail) {
    const { stages, reqId: tableReqId } = stageTable(st.projectDir, st.reqId ?? undefined)
    const running = stages.find((x) => x.status.includes('进行中'))
    const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
    const targetStage = running?.name ?? lastDone?.name ?? null
    st.reqId = st.reqId || tableReqId || null
    st.pendingReject = { stage: targetStage, at: Date.now() }
    store.save(groupId, { ...st, reqId: st.reqId, pendingReject: st.pendingReject })
    await sendPlain(
      groupId,
      targetStage
        ? `收到，打回${targetStage}阶段，请提供修改意见。\n（回「取消」可以撤销打回）`
        : '收到，打回当前阶段，请提供修改意见。',
      { replyTo },
    )
    return
  }

  // ── 绑定检查：批准/打回/继续 必须已有绑定需求 ──
  if (
    (intent === INTENT.APPROVE || intent === INTENT.REJECT || intent === INTENT.CONTINUE) &&
    !st.reqId
  ) {
    // 尝试从编排记录恢复绑定（bridge 重启/状态丢失的自愈）
    const { stage, reqId } = currentStage(st.projectDir)
    if (reqId) {
      st.reqId = reqId
      store.save(groupId, { ...st, reqId })
      log(`[${groupId}] 绑定自愈：从编排记录恢复 reqId=${reqId}`)
    } else {
      await sendPlain(
        groupId,
        '这个群里还没有进行中的需求。直接说需求就行，比如「首页加个欢迎弹窗，手动批准」。',
        { replyTo },
      )
      return
    }
  }

  // ── 含糊消息：bridge 反问，不交给 agent 猜 ──
  if (intent === INTENT.CONTENT && isAmbiguous(text, st)) {
    await sendPlain(groupId, ambiguousReply(st.waitingLabel), { replyTo })
    return
  }

  const isContinuation = !!st.sessionId && st.status !== STATES.IDLE

  // ── 编排锚点 + 路由骨架（第 3 层：每回合强制注入）──
  const { stage: anchorStage, reqId: anchorReq } = currentStage(st.projectDir)
  const effectiveReqId = st.reqId || anchorReq
  const anchor = effectiveReqId
    ? anchorBlock({ reqId: effectiveReqId, projectDir: st.projectDir, stage: anchorStage, envHints: config.envHints })
    : ''

  const promptBody = routedPrompt({
    intent,
    userText: text,
    bind: {
      reqId: effectiveReqId,
      stage: anchorStage,
      waitingLabel: st.waitingLabel,
      rejectReason: intentDetail,
    },
  })

  if (isDryRun) {
    log(`[dry-run] 意图=${intent} 绑定=${effectiveReqId ?? '无'}\nprompt：\n${anchor}\n${promptBody}`)
    await sendPlain(groupId, `[dry-run] 收到，不实际执行。`, { replyTo })
    return
  }

  // 消息 1：用户发消息后立刻回一条当前状态（不等 agent）
  await sendAck(groupId, st, replyTo, intent)

  handleTurn(groupId, text, {
    isContinuation,
    replyTo,
    anchor,
    promptBody,
    intent,
  }).catch((e) => log(`回合启动失败：${e.message}`))
})

// ────────────────────────────── 启动 ──────────────────────────────

if (config.groupPolicy.mode === 'deny') {
  console.error('[启动失败] groupPolicy.mode=deny，不会服务任何群。')
  process.exit(1)
}
if (config.groupPolicy.mode === 'allowlist' && !config.groups.length) {
  console.error('[启动失败] groupPolicy.mode=allowlist 但 groups 为空，请在 groups 里列出允许的群。')
  process.exit(1)
}

// 启动时清理脏状态：bridge 上一次退出时若有回合在跑，.state 里会留下
// status=running 但 sessionId=null 的孤儿（正常 running 必有 sessionId）。
// 置回 waiting 并告知群里，防止用户的新消息被「上一个回合还在跑」卡住。
function cleanupOrphanStates() {
  // 遍历 .state 下所有群状态文件——groupPolicy=auto 时 config.groups 可能为空，
  // 按 config 遍历会漏掉自动发现群的状态
  for (const groupId of store.allGroupIds()) {
    const st = store.get(groupId)
    if (!st || st.status !== 'running' || st.sessionId) continue
    store.save(groupId, { ...st, status: 'waiting' })
    log(`[${groupId}] 清理孤儿回合状态（上次 bridge 退出时的残留）`)
  }
}
cleanupOrphanStates()

// ─────────────────── 管理面板的 HTTP API ───────────────────

/** 组装本实例的完整状态快照（面板 /api/status 的唯一数据源） */
function buildSnapshot() {
  const groups = machine
    .listAll()
    // 过滤掉项目目录已消失的残留（比如测试用临时目录留下的 state 文件）
    .filter((g) => {
      try {
        return existsSync(g.projectDir)
      } catch {
        return false
      }
    })
    .map((g) => {
    const table = stageTable(g.projectDir, g.reqId ?? undefined)
    const stages = table.stages
    const running = stages.find((x) => x.status.includes('进行中'))
    const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
    return {
      groupId: g.groupId,
      groupName: knownGroups.get(g.groupId)?.name ?? null,
      // state 里丢了就用编排记录恢复（面板不该显示「未绑定需求」）
      reqId: g.reqId ?? table.reqId ?? null,
      stage: (running ?? lastDone)?.name ?? null,
      stageStatus: running ? '进行中' : lastDone ? '已完成' : '未开始',
      stageStartedAt: g.stageStartedAt || null,
      status: g.status,
      waitingLabel: g.waitingLabel || '',
      turn: g.turn ?? 0,
      initiator: g.initiator ?? null,
      lastActiveAt: g.lastActiveAt ?? null,
      activeTurn: runtime.turnInfo(g.groupId),
      stages: stages.map((x) => ({ name: x.name, status: x.status })),
    }
  })

  return {
    instance: {
      pid: process.pid,
      port: apiPort,
      startedAt: runtime.startedAt,
      nodeVersion: process.version,
      cwd: process.cwd(),
      // QQ 真实昵称（get_login_info），和 config.botName（对外自称）区分开
      botNickname: botNickname ?? null,
    },
    config: {
      profile: config.profile,
      botQQ: config.bot.qq,
      botName: config.bot.name,
      projectDir: config.projectDir,
      groupPolicy: config.groupPolicy.mode,
      model: config.modelLabel ?? null,
      heartbeatMinutes: config.heartbeat?.idleMinutes ?? 5,
      turnTimeoutMin: Math.round(config.turnTimeoutMs / 60000),
    },
    onebot: {
      url: config.onebot.ws,
      connected: bot.connected === true,
      selfId: bot.selfId ?? null,
    },
    groups,
    resources: runtime.resources(),
    recentEvents: runtime.recentLogs(50),
    at: Date.now(),
  }
}

/** 面板：终止某群当前任务 */
async function stopGroup(groupId) {
  const st = machine.peek(groupId)
  if (!st) return { ok: false, error: '这个群不在服务范围内' }
  const killed = machine.interrupt(groupId)
  return killed
    ? { ok: true, message: '已终止当前回合' }
    : { ok: false, error: '该群当前没有在跑的回合' }
}

/** 面板：重启某群任务（先掐断，再用「继续」骨架重新起一回合） */
async function restartGroup(groupId) {
  const st = machine.peek(groupId)
  if (!st) return { ok: false, error: '这个群不在服务范围内' }

  machine.interrupt(groupId)
  await sleep(300)

  const { stage, reqId } = currentStage(st.projectDir)
  const effectiveReqId = st.reqId || reqId
  const bound = { reqId: effectiveReqId, stage, waitingLabel: st.waitingLabel }
  const anchorText = effectiveReqId
    ? anchorBlock({
        reqId: effectiveReqId,
        projectDir: st.projectDir,
        stage,
        envHints: config.envHints,
      })
    : ''
  const promptBody = routedPrompt({ intent: INTENT.CONTINUE, userText: '（管理员从面板重启）', bind: bound })

  handleTurn(groupId, '（管理员从面板重启）', {
    isContinuation: !!st.sessionId && st.status !== STATES.IDLE,
    anchor: anchorText,
    promptBody,
    intent: INTENT.CONTINUE,
  }).catch((e) => log(`重启失败：${e.message}`))

  return { ok: true, message: '已重启' }
}

// 实例注册 + HTTP 服务
const registry = new InstanceRegistry(config.repoRoot)
let apiPort = 0

function startApi() {
  if (config.panel?.enabled === false) return
  const server = createBridgeServer({
    runtime,
    config,
    snapshot: buildSnapshot,
    stopGroup,
    restartGroup,
    // 面板保存设置后热更新，不用重启 bridge
    applySettings: (patch) => {
      if (Array.isArray(patch?.adminUsers)) {
        config.adminUsers = patch.adminUsers.map((x) => String(x))
        runtime.info(`[面板] 白名单已更新：${config.adminUsers.join(', ') || '（空）'}`)
      }
      return { ok: true }
    },
    token: config.panel?.token ?? '',
  })
  const tryListen = (port, attempt = 0) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < 20) {
        tryListen(port + 1, attempt + 1)
      } else {
        runtime.error(`HTTP API 启动失败：${err.message}`)
      }
    })
    server.listen(port, '127.0.0.1', () => {
      apiPort = server.address().port
      registry.register({
        pid: process.pid,
        port: apiPort,
        profile: config.profile,
        projectDir: config.projectDir,
        logFile: pathJoin(config.repoRoot, '.logs'),
        gitCommit: process.env.GIT_COMMIT ?? null,
        version: '0.1.0',
      })
      runtime.info(`面板 API：http://127.0.0.1:${apiPort}/api/status`)
      const siblings = registry.findSiblings(config.projectDir, process.pid)
      if (siblings.length) {
        runtime.warn(
          `检测到 ${siblings.length} 个其他实例正在服务同一项目（PID ${siblings.map((x) => x.pid).join(', ')}）——会重复响应群消息`,
        )
      }
    })
  }
  tryListen(config.panel?.port ?? 7878)
}

startApi()

bot.connect()

const shutdown = () => {
  log('正在退出…')
  // 有回合在跑时告知群里，避免「发了消息没下文」
  try {
    for (const groupId of machine.active.keys()) {
      if (machine.isRunning(groupId)) {
        // 尽力而为：连接可能已断
        bot.sendGroupMsg(groupId, 'bridge 正在重启，当前回合的结果可能不会送达。重启后发「继续」可以接着跑。').catch(() => {})
      }
    }
  } catch {
    /* ignore */
  }
  try {
    registry.unregister()
  } catch {
    /* ignore */
  }
  runtime.close()
  bot.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
