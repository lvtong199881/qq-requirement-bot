/**
 * v2 接入层单测：群消息怎么变成状态机推进。
 *
 * mock 掉真进程和真发消息，验证「首条消息 / 追问回答 / 运行中排队 / 卡住重试」
 * 这四种入口行为。这一层是 v2 唯一和 QQ 打交道的代码，
 * 它接错了，前面所有单测都白跑。
 *   node test/flow-bridge.js
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFlowBridge, makeReqId, makeReqName, formatDecisions, uniqueReqId, buildAnswerBlock } from '../src/flow-bridge.js'
import { getCheckpoint } from '../src/flow.js'
import { receiptFile } from '../src/orchestrator.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const repoRoot = mkdtempSync(join(tmpdir(), 'flowbridge-'))
const projectDir = join(repoRoot, 'project')
mkdirSync(projectDir, { recursive: true })
for (const role of ['req', 'design', 'tech-plan', 'dev', 'review', 'test', 'acceptance']) {
  mkdirSync(join(repoRoot, 'skills', role), { recursive: true })
  writeFileSync(join(repoRoot, 'skills', role, 'SKILL.md'), `# ${role}\n你是 ${role}。`)
}

/** 内存版 store + machine，行为对齐真实实现里 v2 用到的部分 */
function makeDeps({ replyPlan = {} } = {}) {
  const saved = new Map()
  const sent = []
  const agentCalls = []
  const queued = []

  const store = {
    get: (g) => saved.get(g) ?? null,
    save: (g, st) => saved.set(g, JSON.parse(JSON.stringify(st))),
    clear: (g) => saved.set(g, {}),
  }

  let running = false
  const machine = {
    isRunning: () => running,
    acquire: (g, aborter) => {
      if (running) return null
      running = true
      return () => { running = false }
    },
    enqueue: (g, text) => { queued.push(text); return queued.length },
    drainQueue: () => queued.splice(0),
    interrupt: () => false,
    peek: (g) => saved.get(g) ?? null,
  }

  const deps = {
    config: {
      orchestrator: 'v2',
      messageTemplates: {},
      turnTimeoutMs: 1000,
      heartbeat: { enabled: false, idleMinutes: 5 },
      dshBin: 'dsh',
      profile: 'test',
      limits: { maxMessagesPerMinute: 100 },
    },
    store,
    machine,
    log: () => {},
    sendPlain: async (g, text) => { sent.push(text) },
    runTurn: async ({ prompt, sessionId }) => {
      const m = prompt.match(/【本回合只做这一步】.*（([\w-]+)）/)
      const id = m?.[1]
      const cp = id ? getCheckpoint(id) : null
      agentCalls.push({ id, sessionId })
      const plan = replyPlan[id] ?? {}
      if (cp && plan.skip !== true) {
        const reqId = prompt.split('｜')[1]?.split('\n')[0]?.trim()
        const reqDir = join(projectDir, 'docs/requirements', reqId)
        mkdirSync(reqDir, { recursive: true })
        for (const out of cp.output ?? []) {
          if (out.endsWith('/')) {
            mkdirSync(join(reqDir, out), { recursive: true })
            writeFileSync(join(reqDir, out, 'x.json'), '{}')
          } else {
            writeFileSync(join(reqDir, out), '内容')
          }
        }
        writeFileSync(
          join(reqDir, receiptFile(id)),
          JSON.stringify(plan.receipt ?? { status: 'done', summary: 'ok' }),
        )
      }
      return { ok: plan.ok !== false, sessionId: `sid-${id}`, error: plan.ok === false ? 'boom' : null }
    },
    bot: { uploadGroupFile: async () => {} },
    modelEnv: {},
    repoRoot,
    gitDiff: () => '+++ b/a.js',
  }

  return { deps, saved, sent, agentCalls, queued }
}

function newState(groupId = 'g1') {
  return { groupId, projectDir, reqId: null, flow: null, initiator: null }
}

console.log('\n== makeReqId / makeReqName ==')
{
  const id = makeReqId()
  check('需求标识是 8 位随机', /^[a-z0-9]{8}$/.test(id), id)
  check('两次不重复', makeReqId() !== id)
  check('name 取原文截断', makeReqName('welcome modal 首页加个欢迎弹窗').includes('welcome'))
  check('name 不超过 30 字', makeReqName('很长'.repeat(50)).length <= 30)
}

console.log('\n== 用户回答按问题展开 ==')
{
  const root = mkdtempSync(join(tmpdir(), 'ans-'))
  const dir = join(root, 'docs/requirements/demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '待提问清单.md'),
    ['| 编号 | 问题 | 会改变什么 | 推荐答案 |', '| --- | --- | --- | --- |',
     '| Q-1 | 弹窗时机 | 范围 | 首次启动 |', '| Q-2 | 是否记住关闭 | 验收 | 记住 |'].join('\n'),
  )
  const block = buildAnswerBlock(root, 'demo', 'BA')
  check('写明是用户回答', block.includes('用户对上一轮提问的回答'))
  check('保留原话', block.includes('「BA」'))
  check('Q-1 对应第一个字母', block.includes('Q-1 弹窗时机 → 用户选 B'), block)
  check('Q-2 对应第二个字母', block.includes('Q-2 是否记住关闭 → 用户选 A'), block)
  check('说明以用户选择为准', block.includes('不要改回推荐答案'))

  // 字母不够时，缺的标成未回答
  const short = buildAnswerBlock(root, 'demo', 'B')
  check('字母不足时不硬凑（短于 3 个走原样引用）', !short.includes('用户选 B') || short.includes('自然语言'))

  // 自然语言回答不瞎展开
  const natural = buildAnswerBlock(root, 'demo', '按推荐，但第二个要改成记住')
  check('自然语言走原样引用', natural.includes('用户原话') && natural.includes('自然语言'))

  // 没有回答就不生成段
  check('空回答返回空串', buildAnswerBlock(root, 'demo', '') === '')
  rmSync(root, { recursive: true, force: true })
}

console.log('\n== 需求标识去重 ==')
{
  const root = mkdtempSync(join(tmpdir(), 'uniq-'))
  const reqs = join(root, 'docs/requirements')
  mkdirSync(join(reqs, 'demo'), { recursive: true })
  check('空目录不占位（bridge 建 flow 时会先 mkdir）', uniqueReqId(root, 'demo') === 'demo')
  writeFileSync(join(reqs, 'demo', 'PRD.md'), 'x')
  check('有产物后加后缀', uniqueReqId(root, 'demo') === 'demo-2', uniqueReqId(root, 'demo'))
  mkdirSync(join(reqs, 'demo-2'), { recursive: true })
  writeFileSync(join(reqs, 'demo-2', 'x.md'), 'x')
  check('连续占用继续递增', uniqueReqId(root, 'demo') === 'demo-3', uniqueReqId(root, 'demo'))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n== formatDecisions ==')
{
  const text = formatDecisions([
    { q: '弹窗时机', options: [{ text: '首次启动', recommended: true }, { text: '每次启动' }] },
  ])
  check('渲染编号和选项', text.includes('1. 弹窗时机') && text.includes('A. 首次启动（推荐）') && text.includes('B. 每次启动'), text)
}

console.log('\n== 首条消息：受理需求并跑到等用户回答 ==')
{
  const { deps, saved, sent, agentCalls } = makeDeps()
  const bridge = createFlowBridge(deps)
  const st = newState()
  await bridge.handleMessage({ groupId: 'g1', text: 'welcome modal 首页加个欢迎弹窗', replyTo: 1, st, initiator: { userId: 'u1', nickname: '产品' } })

  const flow = saved.get('g1').flow
  check('生成了随机需求标识', /^[a-z0-9]{8}$/.test(flow.reqId), flow.reqId)
  check('name 是原文截断', String(flow.name).includes('welcome'), flow.name)
  check('停在需求澄清等用户', flow.status === 'waiting_user', flow.status)
  check('只跑了一个 agent 回合', agentCalls.length === 1, String(agentCalls.length))
  check('回合是 req-questions', agentCalls[0].id === 'req-questions')
  check('首次会话是新起（无 sessionId）', agentCalls[0].sessionId === null)
  check('播报受理', sent.some((t) => t.includes('开始处理')))
  check('播报阶段完成', sent.some((t) => t.includes('需求澄清阶段已完成')))
  check('播报在等用户', sent.some((t) => t.includes('等你回复')))
  check('需求绑进群状态', saved.get('g1').reqId === flow.reqId, `${saved.get('g1').reqId} vs ${flow.reqId}`)
}

console.log('\n== 用户回答：需求定稿并复用会话 ==')
{
  const { deps, saved, sent, agentCalls } = makeDeps()
  const bridge = createFlowBridge(deps)
  const st = newState()
  await bridge.handleMessage({ groupId: 'g1', text: 'welcome modal 首页加个欢迎弹窗', replyTo: 1, st, initiator: null })
  const afterFirst = saved.get('g1')

  await bridge.handleMessage({ groupId: 'g1', text: '1. 首次启动 2. 记住关闭 3. 用这句文案', replyTo: 2, st: afterFirst, initiator: null })

  const flow = saved.get('g1').flow
  check('定稿回合拿到了用户回答', flow.vars.userAnswer.includes('首次启动'), flow.vars.userAnswer)
  check('定稿复用需求 agent 会话', agentCalls[1].sessionId === 'sid-req-questions', String(agentCalls[1].sessionId))
  check('后续进入设计', agentCalls[2]?.id === 'design', agentCalls[2]?.id)
  check('设计用新会话', agentCalls[2]?.sessionId === null)
  // 合并是开发回合，跑完直接收尾
  check('合并回合执行完，流程走完', flow.status === 'done', flow.status)
  check('播报完成', sent.some((t) => t.includes('全部完成')))
}

console.log('\n== 运行中插话：排队不打断 ==')
{
  const { deps, saved, sent, queued } = makeDeps()
  const bridge = createFlowBridge(deps)
  // 手动把 machine 置为运行中
  const release = deps.machine.acquire('g1', new AbortController())
  check('acquire 成功', typeof release === 'function')

  little: {
    const st = newState()
    await bridge.handleMessage({ groupId: 'g1', text: '再说一句', replyTo: 3, st, initiator: null })
    check('消息进了队列', queued.includes('再说一句'), JSON.stringify(queued))
    check('提示已排队', sent.some((t) => t.includes('排队')))
    check('没有起 agent 回合', !saved.get('g1'))
  }
}

console.log('\n== /stop 打断 ==')
{
  const { deps, sent } = makeDeps()
  const bridge = createFlowBridge(deps)
  await bridge.handleMessage({ groupId: 'g1', text: '/stop', replyTo: 4, st: newState(), initiator: null })
  check('回了提示', sent.length === 1 && sent[0].includes('没有在跑'))
}

console.log('\n== agent 要用户拍板：把问题渲染出来 ==')
{
  const { deps, saved, sent } = makeDeps({
    replyPlan: {
      'req-questions': { receipt: { status: 'needs_input', decisions: [{ q: '弹窗时机？', options: [{ text: '首次启动', recommended: true }] }] } },
    },
  })
  const bridge = createFlowBridge(deps)
  await bridge.handleMessage({ groupId: 'g1', text: 'welcome modal 加弹窗', replyTo: 5, st: newState(), initiator: null })

  const flow = saved.get('g1').flow
  check('状态 waiting_user', flow.status === 'waiting_user')
  check('问题进 waiting', flow.waiting.decisions.length === 1)
  check('群里看到了问题', sent.some((t) => t.includes('弹窗时机') && t.includes('首次启动')), sent.join(' / '))
}

console.log('\n== 返工不播「完成」 ==')
{
  // 用独立的需求标识，否则上一个用例写过的产物会让「缺失」的校验通过
  const { deps, sent } = makeDeps({ replyPlan: { 'req-questions': { skip: true } } })
  const bridge = createFlowBridge(deps)
  await bridge.handleMessage({ groupId: 'g1', text: 'retrycase 加弹窗', replyTo: 6, st: newState(), initiator: null })
  check('没有阶段完成消息', !sent.some((t) => t.includes('需求澄清阶段已完成')), sent.join(' / '))
}

console.log('\n== 卡住后用户说一句，重新试 ==')
{
  const { deps, saved, sent } = makeDeps({
    replyPlan: { 'req-questions': { receipt: { status: 'blocked', blockers: [{ reason: '缺 Figma 授权' }] } } },
  })
  const bridge = createFlowBridge(deps)
  const st = newState()
  await bridge.handleMessage({ groupId: 'g1', text: 'welcome modal 加弹窗', replyTo: 7, st, initiator: null })
  check('卡住状态', saved.get('g1').flow.status === 'blocked')
  check('群里说明了卡点', sent.some((t) => t.includes('Figma')))

  // 用户给指示后重试：这次让它成功
  const retryDeps = makeDeps()
  const retryBridge = createFlowBridge(retryDeps.deps)
  const blockedState = { ...saved.get('g1'), flow: { ...saved.get('g1').flow } }
  blockedState.flow.status = 'blocked'
  await retryBridge.handleMessage({ groupId: 'g1', text: '授权好了，继续', replyTo: 8, st: blockedState, initiator: null })
  check('重试后进入 waiting_user', retryDeps.saved.get('g1').flow.status === 'waiting_user', retryDeps.saved.get('g1').flow.status)
}

console.log('\n== 已完成的群：再发消息只提示完成 ==')
{
  const { deps, sent } = makeDeps()
  const bridge = createFlowBridge(deps)
  const st = newState()
  st.flow = { reqId: 'done-req', status: 'done', current: null, rounds: {}, history: [] }
  await bridge.handleMessage({ groupId: 'g1', text: '再来个新需求', replyTo: 9, st, initiator: null })
  check('提示已完成', sent.some((t) => t.includes('全部完成')), sent.join(' / '))
}

console.log('\n== 旧版绑过需求的群：v2 不接管 ==')
{
  const { deps, sent, agentCalls } = makeDeps()
  const bridge = createFlowBridge(deps)
  const st = { ...newState(), reqId: 'old-req-from-v1' }
  await bridge.handleMessage({ groupId: 'g1', text: '再来个新需求', replyTo: 11, st, initiator: null })
  check('提示不接管', sent.some((t) => t.includes('不接管已有需求')), sent.join(' / '))
  check('没有起 agent', agentCalls.length === 0, String(agentCalls.length))
}

console.log('\n== dsh 找不到：报配置错误，不返工 ==')
{
  const { deps, sent } = makeDeps()
  // 模拟 spawn 失败：这不是 agent 的错，重试三次也不会好
  deps.runTurn = async () => ({ spawnFailed: true, errorSummary: '启动 dsh 失败（ENOENT）' })
  const bridge = createFlowBridge(deps)
  const st = newState()
  await bridge.handleMessage({ groupId: 'g1', text: 'spawnfail 测试', replyTo: 12, st, initiator: null })

  check('报了 dshBin 配置问题', sent.some((t) => t.includes('dshBin')), sent.join(' / '))
  check('没有当成阶段完成播报', !sent.some((t) => t.includes('阶段已完成')))
  check('没有走三次返工', !sent.some((t) => t.includes('连续 3 轮')))
}

console.log('\n== 空消息：提示怎么说需求 ==')
{
  const { deps, sent } = makeDeps()
  const bridge = createFlowBridge(deps)
  await bridge.handleMessage({ groupId: 'g1', text: '   ', replyTo: 10, st: newState(), initiator: null })
  check('提示直接说需求', sent.some((t) => t.includes('直接说需求')), sent.join(' / '))
}

rmSync(repoRoot, { recursive: true, force: true })
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
