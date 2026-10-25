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
import { sanitize, RateLimiter, sleep } from './format.js'
import { snapshot, diffSnapshot, uploadName, touchedReqIds, currentStage, stageTable } from './artifacts.js'
import {
  classifyMessage,
  isAmbiguous,
  anchorBlock,
  routedPrompt,
  ambiguousReply,
  INTENT,
} from './router.js'
import { SessionStore, GroupStateMachine, STATES } from './state.js'
import { existsSync } from 'node:fs'

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

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a)
const detail = (...a) => config.verbose && console.log('  ', ...a)

log(`配置就绪：skill=${config.skillDir}`)
log(`项目目录：${config.projectDir}`)
log(`群策略：${config.groupPolicy.mode}${config.groupPolicy.mode === 'auto' ? '（拉进哪个群就服务哪个群）' : ''}`)

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

// ─────────────────── 群消息播报（四类，全部由 bridge 生成）───────────────────
// 用户明确要求：agent 的文字一律不进群，群里只出现状态播报。
//   1. 用户发消息后的回执：当前XX阶段中，已进行X分钟
//   2. 阶段播报：XX阶段已开始 / XX阶段已完成（附产物）
//   3. 心跳：当前XX阶段中，已进行X分钟
//   4. 异常：XX阶段异常，请联系bot管理员，异常原因如下：…

/** 把毫秒差格式化成「12 分钟」 */
function minsText(fromTs) {
  if (!fromTs) return '0 分钟'
  const m = Math.max(0, Math.round((Date.now() - fromTs) / 60000))
  return `${m} 分钟`
}

/**
 * 同步阶段状态并生成要播报的消息。
 * 阶段真值来自编排记录的「阶段进度」表，不看 agent 说了什么。
 *
 * @param {object} st 群状态
 * @returns {{messages: string[], running: string|null, finishedNow: string[], patch: object}}
 */
function planStageAnnounce(st) {
  const { stages } = stageTable(st.projectDir, st.reqId ?? undefined)
  const running = stages.find((x) => x.status.includes('进行中'))?.name ?? null
  const finishedNow = stages.filter((x) => x.status.includes('已完成')).map((x) => x.name)

  const messages = []
  const patch = {}

  // 首次观测：把历史已完成阶段全部记为已知，避免把老阶段播报一遍
  const known = st.finishedStages
  if (known === null || known === undefined) {
    patch.finishedStages = finishedNow
  } else {
    const knownSet = new Set(known)
    for (const name of finishedNow) {
      if (!knownSet.has(name)) {
        messages.push(`${name}阶段已完成。`)
        patch.finishedStages = [...finishedNow]
      }
    }
  }

  // 阶段切换 → 播报「已开始」，并重置阶段计时
  if (running && running !== st.stage) {
    messages.push(`${running}阶段已开始。`)
    patch.stage = running
    patch.stageStartedAt = Date.now()
  } else if (!running && st.stage) {
    // 阶段都完成了但还没进入下一阶段：保留最后一次阶段名，避免回执说「没有阶段」
    patch.stage = st.stage
  }

  return { messages, running, finishedNow, patch }
}

/** 消息 1：用户发消息后的回执 */
async function sendAck(groupId, st, replyTo, intent) {
  const { stages } = stageTable(st.projectDir, st.reqId ?? undefined)
  const running = stages.find((x) => x.status.includes('进行中'))

  // 进行中：不论用户说了什么，都只回一句状态（这是他要知道的全部）
  if (running) {
    await sendPlain(groupId, `当前${running.name}阶段中，已进行 ${minsText(st.stageStartedAt)}。`, { replyTo })
    return
  }

  // 没有进行中阶段：按意图回执，避免同一句话重复出现
  const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
  const tag = lastDone ? `${lastDone.name}阶段已完成，` : ''
  const byIntent = {
    approve: `${tag}收到批准，正在启动下一阶段。`,
    reject: `${tag}收到修改意见，正在转给对应阶段处理。`,
    continue: `${tag}正在继续。`,
    new_req: '收到，开始新需求。',
  }
  const msg = byIntent[intent] ?? (lastDone ? `${tag}等你确认。` : '当前没有进行中的阶段。')
  await sendPlain(groupId, msg, { replyTo })
}

async function handleTurn(groupId, userText, { isContinuation, replyTo, anchor, promptBody, intent }) {
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
    sendPlain(groupId, `当前${running.name}阶段中，已进行 ${minsText(st.stageStartedAt)}。`).catch(() => {})
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
        // 主进程死了但 runTurn 还没 resolve（罕见，比如被外部 kill）：
        // 心跳必须停，否则群里会持续收到「正在XX阶段」的鬼魂消息
        child.on('close', () => {
          if (!turnDone) {
            log(`[${groupId}] 子进程提前退出`)
            clearInterval(heartbeat)
          }
        })
      },
      onEvent: (ev) => {
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
    // 消息 4：异常播报（固定格式，方便用户/管理员一眼定位）
    const stageName = (planStageAnnounce({ ...st, reqId: st.reqId }).running) ?? st.stage ?? '当前'
    const abnormal = (reason) =>
      sendPlain(groupId, `${stageName}阶段异常，请联系 bot 管理员，异常原因如下：\n${reason}`, { replyTo })

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

    // 阶段完成时把产物名和待确认点并进同一条，避免又多出几条零碎消息
    const pendingNote = gate.state === 'waiting' && gate.label ? `等你确认：${gate.label}` : ''

    const lines = []
    for (const msg of planned.messages) {
      if (msg.endsWith('阶段已完成。')) {
        const parts = [msg]
        if (uploadedNames.length) parts.push(`产物：${uploadedNames.join('、')}`)
        if (pendingNote) parts.push(pendingNote)
        lines.push(parts.join('\n'))
      } else {
        lines.push(msg)
      }
    }
    // 没有任何阶段变化但有等待事项时，也要让用户知道要决策什么
    if (!lines.length && pendingNote) lines.push(pendingNote)
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

bot.on('connected', async () => {
  log(`已连接 OneBot：${config.onebot.ws}（bot=${config.bot.name}）`)
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

  // 回复时引用用户这条消息，比 @ 自己更像真人
  const replyTo = frame.message_id
  const text = stripAt(frame.message)
  log(`[${groupId}] 收到：${text.slice(0, 80)}`)

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
  bot.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
