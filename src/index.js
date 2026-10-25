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
import { snapshot, diffSnapshot, uploadName } from './artifacts.js'
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
log(`群白名单：${config.groups.map((g) => g.groupId).join(', ') || '（空）'}`)

// ────────────────────────────── 发消息 ──────────────────────────────

async function sendChunked(groupId, text, { prefix = '' } = {}) {
  const chunks = splitChunks(sanitize(text), config.limits.chunkChars, config.limits.maxChunksPerTurn)
  for (let i = 0; i < chunks.length; i++) {
    const head = i === 0 && prefix ? `${prefix}\n` : ''
    const wait = limiter.delayFor()
    if (wait > 0) await sleep(wait)
    try {
      await bot.sendGroupMsg(groupId, `${head}${chunks[i]}`)
    } catch (err) {
      log(`发送失败（${groupId}）：${err.message}`)
    }
  }
  return chunks.length
}

async function sendPlain(groupId, text) {
  const wait = limiter.delayFor()
  if (wait > 0) await sleep(wait)
  try {
    await bot.sendGroupMsg(groupId, text)
  } catch (err) {
    log(`发送失败（${groupId}）：${err.message}`)
  }
}

// ────────────────────────────── 一回合 ──────────────────────────────

async function handleTurn(groupId, userText, { isContinuation }) {
  const st = machine.peek(groupId)
  if (!st) return

  const aborter = new AbortController()
  const release = machine.acquire(groupId, aborter)
  if (!release) {
    machine.enqueue(groupId, userText)
    await sendPlain(groupId, '上一个回合还在跑，你的话我记下了，等它结束后接着处理。')
    return
  }

  const started = Date.now()
  const before = snapshot(st.projectDir)
  let lastSent = ''
  let pendingText = ''
  let turnLabel = ''

  const persist = (patch) => {
    store.save(groupId, { ...st, ...patch, lastActiveAt: Date.now() })
  }
  persist({ status: STATES.RUNNING })

  log(`[${groupId}] 回合开始${isContinuation ? '（续跑）' : '（新会话）'}：${userText.slice(0, 60)}`)

  try {
    // 新会话带上群聊协议；续跑只发用户原话（协议已在首轮上下文里）
    const prompt = isContinuation
      ? userText
      : `${gateInstructions({ botName: config.bot.name, approval: st.approval })}\n\n---\n\n【用户需求】\n${userText}`

    const result = await runTurn({
      dshBin: config.dshBin,
      profile: config.profile,
      projectDir: st.projectDir,
      sessionId: isContinuation ? st.sessionId : undefined,
      prompt,
      env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
      timeoutMs: config.turnTimeoutMs,
      signal: aborter.signal,
      onEvent: (ev) => {
        if (ev.type === 'status' && ev.phase === 'turn_start') {
          detail('turn_start')
        }
        if (ev.type === 'text' && typeof ev.text === 'string') {
          pendingText += ev.text
          // 攒够一段就推，避免群里长时间没动静
          if (pendingText.length >= config.limits.chunkChars) {
            const piece = pendingText
            pendingText = ''
            if (sanitize(piece) !== lastSent) {
              lastSent = sanitize(piece)
              sendChunked(groupId, piece, { prefix: `@${config.bot.name}` }).catch(() => {})
            }
          }
        }
      },
    })

    const gate = parseGate(result.finalText || pendingText)
    turnLabel = gate.label

    // 最终输出
    if (gate.cleaned) {
      await sendChunked(groupId, gate.cleaned, { prefix: isContinuation ? '' : '收到，开始处理。' })
    }

    // 异常收尾
    if (result.timedOut) {
      await sendPlain(
        groupId,
        `这个回合超过 ${Math.round(config.turnTimeoutMs / 60000)} 分钟还没跑完，我已经把它停了。\n` +
          `可以发「继续」让我接着跑，或发更具体的指令。`,
      )
    } else if (result.exitCode !== 0 && !gate.cleaned) {
      const tail = (result.stderr || '').split('\n').filter(Boolean).slice(-3).join('\n')
      await sendPlain(groupId, `回合异常结束（退出码 ${result.exitCode}）。\n${sanitize(tail).slice(0, 400)}`)
    }

    // 产物回传
    if (config.upload.enabled) {
      const changed = diffSnapshot(before, snapshot(st.projectDir), config.upload)
      for (const f of changed) {
        if (!existsSync(f.path)) continue
        try {
          await bot.uploadGroupFile(groupId, f.path, uploadName(st.projectDir, f.path))
          await sleep(300)
        } catch (err) {
          log(`上传失败 ${f.path}: ${err.message}`)
          await sendPlain(groupId, `产物已生成但上传失败，路径：${f.path}`)
        }
      }
      if (changed.length) detail(`回传 ${changed.length} 个产物`)
    }

    // 落状态
    const nextStatus =
      gate.state === 'waiting' ? STATES.WAITING : gate.state === 'done' ? STATES.IDLE : STATES.WAITING

    persist({
      sessionId: result.sessionId ?? st.sessionId,
      status: nextStatus,
      waitingLabel: gate.state === 'waiting' ? gate.label : '',
      turn: st.turn + 1,
    })

    if (gate.state === 'waiting') {
      await sendPlain(groupId, `等你回复：${gate.label || '请确认'}`)
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

bot.on('connected', () => {
  log(`已连接 OneBot：${config.onebot.ws}（bot=${config.bot.name}）`)
})

bot.on('disconnected', () => {
  log('OneBot 断开，自动重连中…')
})

bot.on('message', async (frame) => {
  if (frame.message_type !== 'group') return
  const groupId = String(frame.group_id)
  const st = machine.peek(groupId)
  if (!st) return // 不在白名单的群，直接忽略

  // 只响应 @ 本 bot
  if (!isAtMe(frame.message, frame.self_id ?? bot.selfId)) return

  const text = stripAt(frame.message)
  log(`[${groupId}] 收到：${text.slice(0, 80)}`)

  if (STOP_WORDS.has(text)) {
    const killed = machine.interrupt(groupId)
    await sendPlain(groupId, killed ? '已打断当前回合。' : '当前没有在跑的回合。')
    return
  }

  if (!text) {
    await sendPlain(groupId, `我在。直接说要做什么就行，比如「Instanto 首页加个欢迎弹窗，手动批准」。`)
    return
  }

  // 重开：清掉旧会话上下文
  if (text === '新需求' || text === '重开') {
    store.clear(groupId)
    await sendPlain(groupId, '已清空上下文，下一条消息开始新需求。')
    return
  }

  const isContinuation = !!st.sessionId && st.status !== STATES.IDLE
  if (isDryRun) {
    log(`[dry-run] 将执行的 prompt：\n${text}`)
    await sendPlain(groupId, `[dry-run] 收到，不实际执行。sessionId=${st.sessionId || '无'}`)
    return
  }

  handleTurn(groupId, text, { isContinuation }).catch((e) => log(`回合启动失败：${e.message}`))
})

// ────────────────────────────── 启动 ──────────────────────────────

if (!config.groups.length) {
  console.error('[启动失败] config.groups 为空，至少要配一个群。')
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
