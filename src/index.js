#!/usr/bin/env node
/**
 * 入口：连接 OneBot，把群里 @产品同学 的消息变成一回合 dsh headless。
 *
 * 消息流：
 *   QQ 群 → NapCat → WebSocket → 这里 → spawn dsh → 解析 NDJSON
 *   → 分条推送回群 → 检测 [[WAITING]] → 保存 sessionId 等下一次 @
 */
import { loadConfig, resolveApiKey } from './config.js'
import { OneBot } from './onebot.js'
import { runTurn } from './runner.js'
import { parseGate, gateInstructions } from './protocol.js'
import { sanitize, splitChunks, RateLimiter, sleep } from './format.js'
import { snapshot, diffSnapshot, uploadName, touchedReqIds, currentStage } from './artifacts.js'
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

const apiKey = resolveApiKey()
if (!apiKey) {
  console.error(
    '[启动失败] 找不到 DEEPSEEK_API_KEY。\n' +
      'headless profile 只认环境变量：请先 export DEEPSEEK_API_KEY=...，\n' +
      '或在 DSH Web GUI 的 Models 页保存过密钥（bridge 会自动从凭证文件读）。',
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
async function sendText(groupId, text, { replyTo } = {}) {
  const wait = limiter.delayFor()
  if (wait > 0) await sleep(wait)

  const seg = replySegment(replyTo)
  const message = seg ? [seg, { type: 'text', data: { text } }] : text

  try {
    await bot.sendGroupMsg(groupId, message)
  } catch (err) {
    log(`发送失败（${groupId}）：${err.message}`)
  }
}

async function sendChunked(groupId, text, { replyTo, prefix = '' } = {}) {
  const chunks = splitChunks(sanitize(text), config.limits.chunkChars, config.limits.maxChunksPerTurn)
  for (let i = 0; i < chunks.length; i++) {
    const body = i === 0 && prefix ? `${prefix}\n${chunks[i]}` : chunks[i]
    // 只有第一条引用原消息，后续分条普通发送，避免刷屏式重复引用
    await sendText(groupId, body, { replyTo: i === 0 ? replyTo : undefined })
  }
  return chunks.length
}

async function sendPlain(groupId, text, { replyTo } = {}) {
  await sendText(groupId, text, { replyTo })
}

// ────────────────────────────── 一回合 ──────────────────────────────

async function handleTurn(groupId, userText, { isContinuation, replyTo, anchor, promptBody, intent }) {
  const st = machine.peek(groupId)
  if (!st) return

  const aborter = new AbortController()
  const release = machine.acquire(groupId, aborter)
  if (!release) {
    machine.enqueue(groupId, userText)
    await sendPlain(groupId, '上一个回合还在跑，你的话我记下了，等它结束后接着处理。', { replyTo })
    return
  }

  const started = Date.now()
  const before = snapshot(st.projectDir)
  let pendingText = ''
  let lastActivityAt = Date.now()
  let turnDone = false // runTurn 是否已 resolve
  let firstReplySent = false // agent 的「先回话」是否已提前发到群里
  let sentHead = '' // 已提前发出的那句回话原文（用于去重）

  // 静默心跳：subagent 干活时群里可能长时间没动静，看着像卡死。
  // 默认 10 分钟一条，可配 heartbeat.idleMinutes。
  const idleMs = (config.heartbeat?.idleMinutes ?? 10) * 60_000
  const heartbeat = setInterval(() => {
    if (config.heartbeat?.enabled === false) return
    const silentMs = Date.now() - lastActivityAt
    if (silentMs < idleMs) return
    lastActivityAt = Date.now()
    const waitedMin = Math.round(silentMs / 60000)
    const { stage } = currentStage(st.projectDir)
    const head = st.reqId ? `${st.reqId} · ` : ''
    const phase = stage ? `${head}正在${stage}阶段` : `${head}正在推进`
    sendPlain(groupId, `${phase}，已等待 ${waitedMin} 分钟。`).catch(() => {})
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
      env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
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
        // 任何活动都刷新心跳计时
        if (ev.type === 'status' && ev.phase === 'step_end') {
          lastActivityAt = Date.now()
        }
        if (ev.type === 'text' && typeof ev.text === 'string') {
          lastActivityAt = Date.now()
          // agent 按协议会先输出一句「打算做什么」——这一段要立刻发出去，
          // 不能等同回合结束，否则用户发完消息要干等好几分钟。
          if (!firstReplySent && pendingText.trim()) {
            const head = pendingText.trim()
            // 只在确实是「一句短回话」时才提前发：太长的是最终结论，等回合结束一起发
            if (head.length <= 80 && !head.includes('[[WAITING]]') && !head.includes('[[DONE]]')) {
              firstReplySent = true
              sentHead = head
              sendChunked(groupId, head, { replyTo }).catch(() => {})
            }
          }
          pendingText += ev.text
        }
      },
    })

    turnDone = true
    const gate = parseGate(result.finalText || pendingText)

    // 最终输出：引用用户那条消息。
    // 若开头那句「先回话」已经在群里发过，就只发剩余部分，避免同一句话出现两遍。
    let body = gate.cleaned
    if (firstReplySent && sentHead && body.startsWith(sentHead.trim().slice(0, 40))) {
      body = body.slice(sentHead.trim().length).trim()
      // agent 的回话与结论之间通常有换行/破折号，清理掉开头残留
      body = body.replace(/^[-—\s]+/, '')
    }
    if (body) {
      await sendChunked(groupId, body, { replyTo })
    }

    // 异常收尾
    if (result.errorSummary) {
      // turn_end 带错误（429 限流 / 凭证失效 / 断网）：讲人话，别让群里无声无息
      await sendPlain(groupId, `⚠️ ${result.errorSummary}`, { replyTo })
    } else if (result.timedOut) {
      await sendPlain(
        groupId,
        `这个回合超过 ${Math.round(config.turnTimeoutMs / 60000)} 分钟还没跑完，我已经把它停了。\n` +
          `可以发「继续」让我接着跑，或发更具体的指令。`,
        { replyTo },
      )
    } else if (result.exitCode !== 0 && !gate.cleaned) {
      const tail = (result.stderr || '').split('\n').filter(Boolean).slice(-3).join('\n')
      await sendPlain(groupId, `回合异常结束（退出码 ${result.exitCode}）。\n${sanitize(tail).slice(0, 400)}`, {
        replyTo,
      })
    }

    // 产物回传
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
      if (changed.length) detail(`回传 ${changed.length} 个产物`)
    }

    // 落状态
    const nextStatus =
      gate.state === 'waiting' ? STATES.WAITING : gate.state === 'done' ? STATES.IDLE : STATES.WAITING

    // 绑定落定：回合后编排记录里最新的需求就是本群绑定的需求
    const stageInfo = currentStage(st.projectDir)
    const reqIdToBind = st.reqId || stageInfo.reqId
    if (reqIdToBind && reqIdToBind !== st.reqId) {
      log(`[${groupId}] 绑定需求：${reqIdToBind}`)
    }

    persist({
      sessionId: result.sessionId ?? st.sessionId,
      status: nextStatus,
      waitingLabel: gate.state === 'waiting' ? gate.label : '',
      reqId: reqIdToBind,
      turn: st.turn + 1,
      projectDir: st.projectDir, // 群首次出现时把项目目录一起固化
    })

    if (gate.state === 'waiting') {
      // label 是 agent 自己写的一句「在等什么」，只在它没写时才追问
      if (!gate.label) await sendPlain(groupId, '需要你拍板，看到上面的问题后回复就行。', { replyTo })
    } else if (gate.state === 'done') {
      await sendPlain(groupId, '这个需求跑完了。要做新需求，直接 @我 说就行。')
    } else if (!gate.cleaned) {
      await sendPlain(groupId, '这一轮结束了，但没看到明确的阶段结论。发「继续」我可以接着跑。')
      persist({ status: STATES.WAITING })
    }

    log(`[${groupId}] 回合结束：${((Date.now() - started) / 1000).toFixed(1)}s，状态=${nextStatus}`)
  } catch (err) {
    log(`[${groupId}] 回合异常：${err.message}`)
    await sendPlain(groupId, `出错了：${err.message}`)
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
    ? anchorBlock({ reqId: effectiveReqId, projectDir: st.projectDir, stage: anchorStage })
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

bot.connect()

const shutdown = () => {
  log('正在退出…')
  bot.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
