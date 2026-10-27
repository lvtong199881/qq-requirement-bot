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
import { createFlowBridge } from './flow-bridge.js'
import { getCheckpoint, CHECKPOINTS } from './flow.js'
import { parseGate, gateInstructions } from './protocol.js'
import { sanitize, RateLimiter, sleep, formatDuration } from './format.js'
import { Runtime } from './runtime.js'
import {
  ackFor,
  planStageAnnounce,
  isFreshGroup,
  groupStageTable,
  recoverReqId,
  stageInfoFor,
  heartbeatMessage,
} from './stage.js'
import { renderMessage } from './messages.js'
import { parseDecisionJson, formatDecision, DECISION_JSON_EXAMPLE } from './decision.js'
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
  isDeliverable,
  isStageRunning,
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

/** 决策格式不合规时，自动让 agent 重写的最大次数 */
const MAX_DECISION_RETRY = 3

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

// v2 编排接入层。createFlowBridge 只捕获依赖，不立刻执行任何动作；
// sendPlain 是函数声明会提升，所以这里引用它不会碰到 TDZ。
const flowBridge = createFlowBridge({
  config,
  store,
  machine,
  log,
  sendPlain,
  runTurn,
  bot,
  modelEnv,
  repoRoot: config.repoRoot,
})

log(`配置就绪：skill=${config.skillDir}`)
log(`编排实现：${config.orchestrator}${config.orchestrator === 'v2' ? '（状态机驱动）' : '（旧版：解析标记与编排记录）'}`)
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

/**
 * 决策格式不合规时，让 agent 重写 ASK 的纠正指令。
 * 走同一个会话续跑，不重复正文，只要求重发标记部分。
 */
function decisionFixPrompt(reason, round) {
  return [
    `你上一条输出的 [[ASK]] 内容不符合约定，已被拦下（第 ${round} 次重写）：${reason}`,
    '',
    '[[ASK]] 后面必须是一个 JSON 数组，结构如下：',
    DECISION_JSON_EXAMPLE,
    '',
    '字段：',
    '- q：问题标题（必填，非空字符串）',
    '- a：选项数组（必填，1～4 个）',
    '- t：选项文字（必填，非空字符串）',
    '- r：是否推荐（true / false，可选）',
    '',
    '规则：',
    '- 问题 1～5 个，每个 1～4 个选项；选项字母由 bridge 自动编排，不用写。',
    '- 只输出 JSON 本身，前后不要写解释文字，不要用 markdown 代码块包。',
    '- 用户看到的是渲染后的整齐列表，选项文字要能独立看懂。',
    '',
    '现在请重新输出：只输出 [[WAITING]] 和 [[ASK]] 两段，不要重复已经说过的正文。',
  ].join('\n')
}

/**
 * 静默让 agent 重写决策内容。
 *
 * 不给用户发任何消息（除了第一次可能要先补阶段播报），
 * 直接拿同一个会话续跑，把纠正要求和格式模板喂回去。
 */
async function requestDecisionFix(groupId, sessionId, reason, round, { stageMessages } = {}) {
  const st = machine.peek(groupId)
  if (!st) return

  // 第一轮重写时把本回合的阶段播报补出去——阶段变了该让用户知道，
  // 只是决策内容还在重写。后续轮次不再重复。
  if (round === 1 && stageMessages?.length) {
    for (const m of stageMessages) await sendPlain(groupId, m).catch(() => {})
  }

  const payload = buildTurnPayload(st, '（重写决策内容）', INTENT.CONTINUE, '')
  handleTurn(groupId, '（重写决策内容）', {
    isContinuation: true,
    anchor: payload.anchor,
    promptBody: decisionFixPrompt(reason, round),
    intent: INTENT.CONTINUE,
    silent: true,
    retried: true,
  }).catch((e) => log(`决策重写失败：${e.message}`))
}

/**
 * 构造一次回合要投给 agent 的内容：锚点 + 路由骨架。
 *
 * 主流程和「排队消息补跑」都要用，之前排队的那个分支忘了传 prompt，
 * 结果子进程收到空 stdin，dsh 报 `a task is required` 然后异常退出。
 */
function buildTurnPayload(st, text, intent, intentDetail) {
  // 新群不去读「最近的编排记录」：那条可能是别人的需求，会把新需求锚到已完成的任务上
  const recovered = stageInfoFor(st)
  const anchorStage = recovered.stage
  const effectiveReqId = st.reqId || recovered.reqId

  const anchor = effectiveReqId
    ? anchorBlock({
        reqId: effectiveReqId,
        projectDir: st.projectDir,
        stage: anchorStage,
        envHints: config.envHints,
      })
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

  return { anchor, promptBody, effectiveReqId, anchorStage }
}

/** 消息 1 的发送壳：文案来自 stage.js 的 ackFor（纯函数，可单测） */
async function sendAck(groupId, st, replyTo, intent, opts = {}) {
  const ack = ackFor(st, intent, config.messageTemplates, opts)

  // 回执说「当前验收阶段中」的同时，把阶段状态也推进——否则这一回合结束时
  // planStageAnnounce 会补报一句「测试阶段已完成」，看起来像和回执打架。
  const planned = planStageAnnounce(st, config.messageTemplates)
  const patch = { ...planned.patch }
  if (ack.reqIdToBind) patch.reqId = ack.reqIdToBind

  if (Object.keys(patch).length) {
    store.save(groupId, { ...st, ...patch })
    if (ack.reqIdToBind) log(`[${groupId}] 绑定自愈（回执）：reqId=${ack.reqIdToBind}`)
    Object.assign(st, patch)
  }

  await sendPlain(groupId, ack.text, { replyTo })
  return ack
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

async function handleTurn(
  groupId,
  userText,
  { isContinuation, replyTo, anchor, promptBody, intent, retried = false, silent = false },
) {
  const st = machine.peek(groupId)
  if (!st) return

  const aborter = new AbortController()
  const release = machine.acquire(groupId, aborter)
  if (!release) {
    // 排队时必须说出来。之前不吭声，用户以为消息被处理了，
    // 实际上在等上一个回合，而且 bridge 一重启就丢——真实踩过。
    machine.enqueue(groupId, userText)
    await sendPlain(
      groupId,
      renderMessage('queued', { text: userText }, config.messageTemplates),
      { replyTo },
    ).catch(() => {})
    return
  }

  const started = Date.now()
  runtime.beginTurn(groupId)
  const before = snapshot(st.projectDir)
  let pendingText = ''

  // 消息 3：心跳——只要群里「距上次发言」够久就补一条状态。
  // 默认 5 分钟，可配 heartbeat.idleMinutes。话术固定，不含任何 agent 内容。
  const idleMs = (config.heartbeat?.idleMinutes ?? 5) * 60_000
  const heartbeat = setInterval(() => {
    if (config.heartbeat?.enabled === false) return
    if (Date.now() - lastActivityAt < idleMs) return
    // 阶段没收尾就报阶段，收尾了还在跑就报回合总时长——不再因为「没有进行中阶段」
    // 整条哑掉（验收后追加修复时能安静半小时，用户以为卡死了）。
    const { key, vals } = heartbeatMessage(st, started)
    lastActivityAt = Date.now()
    sendPlain(groupId, renderMessage(key, vals, config.messageTemplates)).catch(() => {})
  }, 60_000)

  const persist = (patch) => {
    // peek() 的状态视图不含 queued（那是队列内部字段），整体覆盖写盘会把排队中的
    // 消息从盘上抹掉，重启后就无法提示用户「这几条没执行」。
    const saved = store.get(groupId)
    const keepQueued = Array.isArray(saved?.queued) ? { queued: saved.queued } : {}
    store.save(groupId, { ...st, ...patch, ...keepQueued, lastActiveAt: Date.now() })
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
        child.on('close', (code) => {
          // 别在 close 里判断「提前退出」：runTurn 的 resolve 也挂在这个 close 上，
          // 微任务还没跑，此时任何「回合是否结束」的标志都必然还是旧值——等于每次
          // 正常退出都误报（排查线上问题时被这条日志带偏过）。看 exitCode 就够了。
          clearInterval(heartbeat)
          if (code !== 0) log(`[${groupId}] 子进程异常退出（exitCode=${code}）`)
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

    const gate = parseGate(result.finalText || pendingText)

    // agent 的文字不再进群（用户要求：只有四类 bridge 状态消息）。
    // gate.cleaned 仅用于判断阶段结论与等待事项，不直接发送。

    // 异常收尾
    // session 被上一个没退出的 dsh 进程锁住：清掉 sessionId，立刻用新会话重跑一次。
    // 不这么做的话，这个群之后每条消息都会失败（真实踩过：429 打断后进程挂住不释放锁）。
    if (result.sessionLocked && !retried) {
      log(`[${groupId}] session 写锁被占用，清空 sessionId 后用新会话重试`)
      persist({ sessionId: null, status: STATES.IDLE })
      await sendPlain(groupId, renderMessage('sessionReset', {}, config.messageTemplates), { replyTo })
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
    const stageName = (planStageAnnounce({ ...st, reqId: st.reqId }, config.messageTemplates).running) ?? st.stage ?? '当前'
    const abnormal = (reason) => {
      const plain = String(reason ?? '（无详细信息）')
      log(`[${groupId}] 异常播报：${plain.replace(/\n/g, ' / ').slice(0, 200)}`)
      return sendPlain(
        groupId,
        renderMessage('abnormal', { stage: stageName, reason: plain }, config.messageTemplates),
        { replyTo },
      )
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
      // accept = 阶段投递白名单：群里每阶段只收一份产物，其余改动只落盘
      const all = diffSnapshot(before, after, {
        ...config.upload,
        accept: (p) => isDeliverable(p),
      })

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
    const stageInfo2 = stageInfoFor(st)
    const reqIdToBind2 = st.reqId || stageInfo2.reqId
    const planned = planStageAnnounce({ ...st, reqId: reqIdToBind2 })

    // ── 阶段播报先拼好 ──
    // 决策内容可能要重写，但阶段变了这件事不该跟着延迟。
    const stageLines = []
    for (const msg of silent ? [] : planned.messages) {
      if (msg.endsWith('阶段已完成。')) {
        const parts = [msg]
        if (uploadedNames.length) {
          parts.push(
            renderMessage('artifactsLine', { artifacts: uploadedNames.join('、') }, config.messageTemplates),
          )
        }
        stageLines.push(parts.join('\n'))
      } else {
        stageLines.push(msg)
      }
    }

    // ── 要用户拍板时发什么 ──
    // 首选 [[ASK]] 段：agent 按要求把「具体要判断什么」写在标记后面，bridge 负责拼接。
    // 没写 ASK 时退回整段答复（兜底，不至于又只剩一句「等你确认」）。
    let finalAnswer = ''
    let decisionInvalid = false
    if (gate.state === 'waiting' || gate.state === 'done') {
      const ask = (gate.ask || '').trim()
      if (ask) {
        // 决策内容必须是「1. 标题 / A. 选项」结构，不合规就不转发原文——
        // 无脑贴 agent 的散文，用户根本不知道要选什么。
        const parsed = parseDecisionJson(ask)
        if (parsed.ok) {
          finalAnswer = formatDecision(parsed.items)
          if (st.decisionRetry) persist({ decisionRetry: 0 }) // 成功就清零
        } else {
          const round = (st.decisionRetry ?? 0) + 1
          log(`[${groupId}] 决策格式不合规（第 ${round}/${MAX_DECISION_RETRY} 次）：${parsed.reason}`)

          if (round <= MAX_DECISION_RETRY) {
            // 不打扰用户，直接让 agent 重写。阶段播报照常，只是这条决策先压着。
            persist({ decisionRetry: round, sessionId: result.sessionId ?? st.sessionId })
            await requestDecisionFix(groupId, result.sessionId ?? st.sessionId, parsed.reason, round, {
              stageMessages: stageLines,
            })
            return
          }

          // 三次都没改对：这才告诉用户，并把重试计数清零
          persist({ decisionRetry: 0 })
          decisionInvalid = true
          finalAnswer = renderMessage('decisionInvalid', { reason: parsed.reason }, config.messageTemplates)
        }
      } else {
        // 没写 ASK：退回整段答复（兜底，至少不丢信息）
        finalAnswer = (gate.cleaned || '').trim()
      }
    }

    const pendingNote = gate.state === 'waiting' && gate.label ? `等你确认：${gate.label}` : ''

    const lines = [...stageLines]
    // 有最终答复时不再重复 waitingLabel——答复里已经把选项写清楚了
    if (!finalAnswer && pendingNote && lines.length) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}\n${pendingNote}`
    }

    // 要用户拍板的内容，前面明确写「需要决策：」，让人一眼知道这段是等他决定的
    if (finalAnswer) {
      const MAX = 1800
      const body =
        finalAnswer.length > MAX
          ? `${finalAnswer.slice(0, MAX)}\n……（还有 ${finalAnswer.length - MAX} 字，完整内容见需求文档）`
          : finalAnswer
      // 格式不合规的提示自身已经说清楚，别再套一层「需要决策：」
      lines.push(
        decisionInvalid ? body : renderMessage('decision', { content: body }, config.messageTemplates),
      )
    } else if (!lines.length && pendingNote) {
      // agent 没给正文时才用 waitingLabel 兜底
      lines.push(pendingNote)
    }
    // 需求收尾阶段刚完成，或 agent 自己标了 [[DONE]]
    if ((planned.done || gate.state === 'done') && !finalAnswer) {
      lines.push(renderMessage('done', {}, config.messageTemplates))
    }

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
    const stageName = stageInfoFor(st).stage ?? '当前'
    await sendPlain(
      groupId,
      renderMessage('abnormal', { stage: stageName, reason: err.message }, config.messageTemplates),
    ).catch(() => {})
    persist({ status: STATES.WAITING })
  } finally {
    clearInterval(heartbeat)
    runtime.endTurn(groupId)
    release()
    // 处理排队消息：prompt 必须重新构造，不能只把用户原话扔进去
    //（之前漏了这一步，子进程收到空 stdin，dsh 报 a task is required 直接异常退出）
    const queued = machine.drainQueue(groupId)
    if (queued.length) {
      const next = queued.join('\n')
      const cur = machine.peek(groupId)
      if (!cur) {
        // 队列已经从内存和盘上一起清掉了，这里再不吭声就彻底查不到。
        log(`[${groupId}] 排队消息补跑失败：群状态不可用，丢弃 ${queued.length} 条 — ${next.slice(0, 60)}`)
      } else {
        log(`[${groupId}] 补跑排队消息 ${queued.length} 条：${next.slice(0, 60)}`)
        try {
          const nextIntent = classifyMessage(next).intent
          const payload = buildTurnPayload(cur, next, nextIntent, '')
          // 不 await：补跑本身就是下一回合，交给 finally 之后继续跑
          handleTurn(groupId, next, {
            isContinuation: !!cur.sessionId && cur.status !== STATES.IDLE,
            anchor: payload.anchor,
            promptBody: payload.promptBody,
            intent: nextIntent,
          }).catch((e) => log(`排队回合失败：${e.message}`))
        } catch (err) {
          log(`[${groupId}] 排队消息补跑失败：${err.message} — ${next.slice(0, 60)}`)
        }
      }
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
    // 上次退出时还排在队列里的消息，bridge 重启不会自动补跑——
    // 明确告诉用户是哪几条，让人自己决定要不要重发。
    // 用 list（本次拉到的群），排除名单之外的群不打扰。
    for (const g of Array.isArray(list) ? list : []) {
      if ((config.excludeGroups ?? []).includes(String(g.group_id))) continue
      const pending = machine.pendingQueued(g.group_id)
      if (!pending.length) continue
      log(`[${g.group_id}] 有 ${pending.length} 条重启前未执行的消息，已提示用户重发`)
      bot
        .sendGroupMsg(
          g.group_id,
          renderMessage(
            'queuedLost',
            { count: pending.length, list: pending.map((t) => `· ${t}`).join('\n') },
            config.messageTemplates,
          ),
        )
        .catch(() => {})
      machine.clearQueued(g.group_id)
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

  // ── v2 编排：状态机是唯一真相源，不走下面的意图路由 ──
  // 分流点放在这里而不是更早，是因为权限、群信息、initiator 都已经就位。
  // v2 自己处理 /stop 和 /release，其余消息按「新需求 / 回答 / 排队」三态处理。
  if (config.orchestrator === 'v2') {
    return flowBridge.handleMessage({ groupId, text, replyTo, st, initiator })
  }

  // ── /指令（白名单）────────────────────────────────────────────
  const cmd = parseCommand(text)
  if (cmd) {
    // 入口已经保证是群主/群管理员；这里再区分 owner 级与群管级
    const isAdmin =
      gatePerm.role === 'superadmin' ||
      gatePerm.role === 'owner' ||
      config.adminUsers.includes(initiator.userId)

    if (cmd.unknown || !cmd.def) {
      await sendPlain(groupId, renderMessage('unknownCmd', { cmd: cmd.name }, config.messageTemplates), { replyTo })
      return
    }

    if (cmd.def.scope === 'admin' && !isAdmin) {
      await sendPlain(groupId, deniedText(cmd.name, config.messageTemplates), { replyTo })
      return
    }

    if (cmd.name === 'help') {
      const { stages } = groupStageTable(st)
      const running = stages.find((x) => isStageRunning(x.status))
      const statusLine = running
        ? `当前状态：${running.name}阶段中，已进行 ${formatDuration(Date.now() - (st.stageStartedAt || Date.now()))}。`
        : st.waitingLabel
          ? `当前状态：${st.waitingLabel}`
          : '当前状态：没有进行中的任务。'
      await sendPlain(groupId, helpText({ isAdmin, statusLine, templates: config.messageTemplates }), { replyTo })
      return
    }

    if (cmd.name === 'stop') {
      const killed = machine.interrupt(groupId)
      await sendPlain(groupId, renderMessage(killed ? 'stopDone' : 'stopNone', {}, config.messageTemplates), { replyTo })
      return
    }

    if (cmd.name === 'resume') {
      // 走到下面的 CONTINUE 流程，只是把用户原文换成人话
      text = '继续'
    }

    if (cmd.name === 'release') {
      // 二次确认：先记下意图，等用户回「确认」
      if (st.pendingRelease) {
        await sendPlain(groupId, renderMessage('releaseAlready', {}, config.messageTemplates), { replyTo })
        return
      }
      const { stages } = groupStageTable(st)
      const running = stages.find((x) => isStageRunning(x.status))
      st.pendingRelease = { at: Date.now(), by: initiator.userId }
      store.save(groupId, { ...st, pendingRelease: st.pendingRelease })
      await sendPlain(
          groupId,
          releaseConfirmText({ reqId: st.reqId, stage: running?.name, templates: config.messageTemplates }),
          { replyTo },
        )
      return
    }
  }

  // ── /release 的二次确认回复 ──────────────────────────────────
  if (st.pendingRelease) {
    const yes = /^(确认|是|yes|y|ok|好)$/i.test(text.trim())
    st.pendingRelease = null
    store.save(groupId, { ...st, pendingRelease: null })
    if (!yes) {
      await sendPlain(groupId, renderMessage('releaseCancel', {}, config.messageTemplates), { replyTo })
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
      await sendPlain(groupId, renderMessage('rejectCancel', {}, config.messageTemplates), { replyTo })
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
    await sendPlain(groupId, renderMessage(killed ? 'interruptDone' : 'interruptNone', {}, config.messageTemplates), { replyTo })
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
    // 新群显示「未知」，不要拿最近一条编排记录冒充这个群的需求
    const stage = isFreshGroup(st) ? null : currentStage(st.projectDir).stage
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
    // 一个群只做一个需求：做完也还占着这个群。
    // 只有从来没绑过需求的空群才受理新需求，其余一律让用户另开群。
    const existingReq = st.reqId || recoverReqId(st)
    if (existingReq) {
      await sendPlain(
        groupId,
        renderMessage('groupTaken', { reqId: existingReq, reqIdPad: ` ${existingReq} ` }, config.messageTemplates),
        { replyTo },
      )
      return
    }

    if (!intentDetail) {
      store.clear(groupId)
      await sendPlain(groupId, renderMessage('cleared', {}, config.messageTemplates), { replyTo })
      return
    }
    // 空群里带描述：作为新需求受理（回合结束后绑定新 reqId）
    store.clear(groupId)
    st.reqId = null
    st.sessionId = null
    st.status = STATES.IDLE
  }

  // 空消息（只 @ 了 bot，没说内容）：走统一回执，不另写一套话术。
  // 只有这个群还什么都没推进过时，才补一句引导——否则老群里回一句
  // 「直接说要做什么」很突兀。
  if (!text.trim()) {
    const ack = await sendAck(groupId, st, replyTo, INTENT.CONTENT, { hasContent: false })
    // 只有连一个阶段都没有的全新群才补引导
    if (ack.idle) {
      await sendPlain(groupId, renderMessage('idleHint', {}, config.messageTemplates), { replyTo })
    }
    return
  }

  // 打回但没给修改意见：先追问，别让 agent 拿着一个「打回」二字去瞎改
  if (intent === INTENT.REJECT && !intentDetail) {
    const { stages, reqId: tableReqId } = groupStageTable(st)
    const running = stages.find((x) => isStageRunning(x.status))
    const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
    const targetStage = running?.name ?? lastDone?.name ?? null
    st.reqId = st.reqId || tableReqId || null
    st.pendingReject = { stage: targetStage, at: Date.now() }
    store.save(groupId, { ...st, reqId: st.reqId, pendingReject: st.pendingReject })
    await sendPlain(
      groupId,
      renderMessage('rejectAsk', { stage: targetStage ?? '当前' }, config.messageTemplates),
      { replyTo },
    )
    return
  }

  // ── 绑定检查：批准/打回/继续 必须已有绑定需求 ──
  if (
    (intent === INTENT.APPROVE || intent === INTENT.REJECT || intent === INTENT.CONTINUE) &&
    !st.reqId
  ) {
    // 尝试从编排记录恢复绑定（bridge 重启/状态丢失的自愈）；新群不猜别人的需求
    const recoveredId = recoverReqId(st)
    if (recoveredId) {
      st.reqId = recoveredId
      store.save(groupId, { ...st, reqId: recoveredId })
      log(`[${groupId}] 绑定自愈：从编排记录恢复 reqId=${recoveredId}`)
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
    await sendPlain(groupId, ambiguousReply(st.waitingLabel, config.messageTemplates), { replyTo })
    return
  }

  const isContinuation = !!st.sessionId && st.status !== STATES.IDLE

  // ── 编排锚点 + 路由骨架（第 3 层：每回合强制注入）──
  const { anchor, promptBody, effectiveReqId } = buildTurnPayload(st, text, intent, intentDetail)

  if (isDryRun) {
    log(`[dry-run] 意图=${intent} 绑定=${effectiveReqId ?? '无'}\nprompt：\n${anchor}\n${promptBody}`)
    await sendPlain(groupId, renderMessage('dryRun', {}, config.messageTemplates), { replyTo })
    return
  }

  // 消息 1：用户发消息后立刻回一条当前状态（不等 agent）
  const ack = await sendAck(groupId, st, replyTo, intent, { hasContent: !!text.trim() })

  // 需求已经收尾完成：不再起回合。
  // 之前只改回执不改行为，用户说「提交」照样会拉起一个回合，
  // agent 面对一个已经交付完的需求只能瞎问，群里就不断冒出「需要决策」。
  // 新需求同样不起回合——这个群已经占给这个需求了，只回一句「请另开群」。
  if (ack?.allDone) {
    log(`[${groupId}] 需求已完成，这条不计入回合：${text.slice(0, 40)}`)
    return
  }

  // 新需求刚受理：编排记录还不存在，阶段播报要等回合结束才会说「产品需求阶段已开始」，
  // 中间几分钟群里一片安静。这里先补一条，并把阶段写进状态，
  // 回合收尾时 planStageAnnounce 不会再把同一句「已开始」重复一遍。
  if (ack?.kickoff) {
    const startedAt = Date.now()
    store.save(groupId, { ...st, stage: '产品需求', stageStartedAt: startedAt })
    Object.assign(st, { stage: '产品需求', stageStartedAt: startedAt })
    await sendPlain(
      groupId,
      renderMessage('stageStart', { stage: '产品需求' }, config.messageTemplates),
      { replyTo },
    )
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

/**
 * 组装本实例的状态快照。
 *
 * full=true  → /api/status，面板「详细信息」用：带阶段表和最近 50 条事件。
 * full=false → /api/summary，需求大盘列表用：只留列表画得出来的字段。
 *
 * 两者共用同一份计算，避免列表和详情各算一套、结果对不上。
 * 列表每 3 秒轮询一次，把 50 条日志和阶段表都带上纯属浪费带宽。
 */
/** 从 v2 流状态推导阶段列表，给面板详情用 */
function flowStages(flow) {
  const main = CHECKPOINTS.filter((c) => !['fix', 're-review', 'merge-fix'].includes(c.id))
  const idx = main.findIndex((c) => c.id === flow.current)
  return main.map((c, i) => {
    if (idx >= 0 && i < idx) return { name: c.label, status: '已完成' }
    if (idx === i) {
      if (flow.status === 'done') return { name: c.label, status: '已完成' }
      if (flow.status === 'blocked') return { name: c.label, status: '阻塞' }
      if (flow.status === 'waiting_user') return { name: c.label, status: '等待确认' }
      return { name: c.label, status: '进行中' }
    }
    return { name: c.label, status: '未开始' }
  })
}

function buildSnapshot({ full = true } = {}) {
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
    // v2：状态机自己就知道在哪一步，不需要解析编排记录。
    // 以前面板和回执都从同一份 markdown 里猜，格式一改两边一起错。
    if (g.flow) {
      const flow = g.flow
      const cp = flow.current ? getCheckpoint(flow.current) : null
      const statusText =
        { running: '进行中', waiting_user: '等你确认', blocked: '卡住', done: '已完成' }[flow.status] ?? '未开始'
      const item = {
        groupId: g.groupId,
        groupName: knownGroups.get(g.groupId)?.name ?? null,
        reqId: flow.reqId ?? null,
        stage: cp?.label ?? (flow.status === 'done' ? '已交付' : null),
        stageStatus: statusText,
        status: flow.status === 'done' ? 'idle' : 'waiting',
        waitingLabel: flow.waiting?.decisions?.length
          ? `${flow.waiting.decisions.length} 项待决策`
          : flow.waiting?.reason ?? '',
        turn: g.turn ?? 0,
        initiator: g.initiator ?? null,
        lastActiveAt: g.lastActiveAt ?? null,
        activeTurn: runtime.turnInfo(g.groupId),
      }
      if (full) {
        item.stageStartedAt = g.stageStartedAt || null
        item.stages = flowStages(flow)
      }
      return item
    }

    // v1：老路径，从编排记录解析
    const table = groupStageTable(g)
    const stages = table.stages
    const running = stages.find((x) => isStageRunning(x.status))
    const lastDone = [...stages].reverse().find((x) => x.status.includes('已完成'))
    const item = {
      groupId: g.groupId,
      groupName: knownGroups.get(g.groupId)?.name ?? null,
      // state 里丢了就用编排记录恢复（面板不该显示「未绑定需求」）
      reqId: g.reqId ?? table.reqId ?? null,
      stage: (running ?? lastDone)?.name ?? null,
      stageStatus: running ? '进行中' : lastDone ? '已完成' : '未开始',
      status: g.status,
      waitingLabel: g.waitingLabel || '',
      turn: g.turn ?? 0,
      initiator: g.initiator ?? null,
      lastActiveAt: g.lastActiveAt ?? null,
      activeTurn: runtime.turnInfo(g.groupId),
    }
    if (full) {
      item.stageStartedAt = g.stageStartedAt || null
      item.stages = stages.map((x) => ({ name: x.name, status: x.status }))
    }
    return item
  })

  const snap = {
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
    at: Date.now(),
  }
  if (full) snap.recentEvents = runtime.recentLogs(50)
  return snap
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

  const recovered = stageInfoFor(st)
  const stage = recovered.stage
  const effectiveReqId = st.reqId || recovered.reqId
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
    summary: () => buildSnapshot({ full: false }),
    stopGroup,
    restartGroup,
    // 面板保存设置后热更新，不用重启 bridge
    applySettings: (patch) => {
      if (patch?.messageTemplates !== undefined) {
        config.messageTemplates = Object.fromEntries(
          Object.entries(patch.messageTemplates).filter(([, v]) => typeof v === 'string' && v.trim()),
        )
        const n = Object.keys(config.messageTemplates).length
        runtime.info(n ? `[面板] 群消息文案已更新（${n} 条自定义）` : '[面板] 群消息文案已全部回到默认')
      }
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
        bot
          .sendGroupMsg(groupId, renderMessage('restartNotice', {}, config.messageTemplates))
          .catch(() => {})
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
