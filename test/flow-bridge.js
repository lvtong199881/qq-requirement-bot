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
import { execFileSync } from 'node:child_process'
import { createFlowBridge, makeReqId, makeReqName, formatDecisions, uniqueReqId, buildAnswerBlock, askPayloadFor, withToolPaths, warmupAndLease, preflightGit, capDiff } from '../src/flow-bridge.js'
import { getCheckpoint } from '../src/flow/flow.js'
import { receiptFile } from '../src/flow/orchestrator.js'

/**
 * 起需求：v2 没有「群里说一句话就当需求」这条路径了（那是 App 的「新需求」
 * 弹窗调的 createRequirement），测试跟着换成这个封装。返回的 started 一定要
 * await——否则断言会跑在回合结束之前。
 */
async function startReq(bridge, { text, replyTo = 1, st, initiator = null, repoId = 'app' } = {}) {
  const r = await bridge.createRequirement({ groupId: 'g1', text, replyTo, st, initiator, repoId })
  if (r?.started) await r.started
  return r
}

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const repoRoot = mkdtempSync(join(tmpdir(), 'flowbridge-'))
const projectDir = join(repoRoot, 'project')

// 造一个「远端」仓库：团队化改造后 dev 阶段要从 origin 建 worktree，
// 测试里也得有个能被 fetch 的源，否则所有 dev 之后的用例都会卡在初始化。
const originRepo = join(repoRoot, 'origin.git')
mkdirSync(originRepo, { recursive: true })
{
  const g = (args) => execFileSync('git', args, { cwd: originRepo, stdio: 'ignore' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(originRepo, 'README.md'), 'init')
  g(['add', '-A'])
  g(['commit', '-q', '-m', 'init'])
}
mkdirSync(projectDir, { recursive: true })
for (const role of ['req', 'design', 'tech-plan', 'dev', 'review', 'test', 'acceptance']) {
  mkdirSync(join(repoRoot, 'skills', role), { recursive: true })
  writeFileSync(join(repoRoot, 'skills', role, 'SKILL.md'), `# ${role}\n你是 ${role}。`)
}

/** 内存版 store + machine，行为对齐真实实现里 v2 用到的部分 */
function makeDeps({ replyPlan = {}, approval = 'manual' } = {}) {
  const saved = new Map()
  const sent = []
  const logs = []
  const agentCalls = []
  const queued = []
  const events = []

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
      // 团队化改造后：文档写 dataRoot，代码在 worktree 里
      // 多仓库配置：单仓库就是一项
      repos: [{
        id: 'app',
        path: projectDir,
        primary: true,
        repoDir: join(repoRoot, 'repo.git'),
        worktreeRoot: join(repoRoot, 'worktrees'),
      }],
      primaryRepo: { id: 'app', path: projectDir, primary: true, repoDir: join(repoRoot, 'repo.git'), worktreeRoot: join(repoRoot, 'worktrees') },
      repoDir: join(repoRoot, 'repo.git'),
      worktreeRoot: join(repoRoot, 'worktrees'),
      dataRoot: join(repoRoot, 'data'),
      remoteUrl: originRepo,
      // 配置指定设备，跳过自动发现——CI/测试机上没有真模拟器
      platform: 'harmony',
      devices: ['mock-hdc-1'],
      tools: {},
      // 和线上一致：人工确认模式。不设这个，流程会一路跑到底，
      // 测试就没法验证「停在某个阶段等用户」的行为。
      approval,
      mainBranch: 'main',
      limits: { maxMessagesPerMinute: 100, maxConcurrentTurns: 2, maxWorktrees: 12, mergeLockWaitMs: 1500 },
    },
    store,
    machine,
    log: (m) => logs.push(String(m)),
    sendPlain: async (g, text) => { sent.push(text) },
    runTurn: async ({ prompt, sessionId }) => {
      const m = prompt.match(/【本回合只做这一步】.*（([\w-]+)）/)
      const id = m?.[1]
      const cp = id ? getCheckpoint(id) : null
      agentCalls.push({ id, sessionId })
      const plan = replyPlan[id] ?? {}
      if (cp && plan.skip !== true) {
        // 产物目录从任务包里读——改造后文档不再落在仓库内，
        // 这里跟着任务包走，不要自己拼路径（否则产物校验必然找不到）
        const reqDir = prompt.match(/- 文档（[^\n]*写到：(.+)/)?.[1]?.trim()
        const reqId = reqDir?.split('/').pop() ?? prompt.split('｜')[1]?.split('\n')[0]?.trim()
        mkdirSync(reqDir, { recursive: true })
        for (const out of cp.output ?? []) {
          if (out.endsWith('/')) {
            mkdirSync(join(reqDir, out), { recursive: true })
            writeFileSync(join(reqDir, out, 'x.json'), '{}')
          } else {
            writeFileSync(join(reqDir, out), '内容')
          }
        }
        // 终检要求这 5 个文件都在。各阶段 output 与它不完全重合（比如 dev 阶段
        // output 是技术方案），mock 里统一补齐，免得测的是「产物齐不齐」而不是流程。
        for (const f of ['需求卡片.md', 'PRD.md', '技术方案.md', '测试报告.md', '验收文档.md']) {
          const p = join(reqDir, f)
          if (!existsSync(p)) writeFileSync(p, '内容')
        }
        writeFileSync(
          join(reqDir, receiptFile(id)),
          JSON.stringify(plan.receipt ?? { status: 'done', summary: 'ok' }),
        )
      }
      return { ok: plan.ok !== false, sessionId: `sid-${id}`, error: plan.ok === false ? 'boom' : null }
    },
    bot: { uploadGroupFile: async () => {} },
    // 假设备服务：测试不该依赖真实模拟器服务，也不该被正在跑的回合抢占
    emulator: {
      lease: async ({ reqId }) => ({ ok: true, deviceId: 'mock-dev-1', lease: { reqId } }),
      release: async () => ({ ok: true }),
      list: async () => ({
        ok: true, platform: 'harmony', label: '鸿蒙',
        items: [{ name: 'mock-dev-1', running: true, leased: false }],
      }),
    },
    modelEnv: {},
    repoRoot,
    gitDiff: () => '+++ b/a.js',
    // 提问卡片走 transport.event，不发文本；这里收下来断言卡片内容
    transport: {
      sendImage: async () => {},
      sendFile: async () => {},
      event: (groupId, kind, payload) => { events.push({ groupId, kind, payload }) },
    },
  }

  return { deps, saved, sent, agentCalls, queued, logs, events }
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
  const block = buildAnswerBlock(join(dir), 'BA')
  check('写明是用户回答', block.includes('用户对上一轮提问的回答'))
  check('保留原话', block.includes('「BA」'))
  check('Q-1 对应第一个字母', block.includes('Q-1 弹窗时机 → 用户选 B'), block)
  check('Q-2 对应第二个字母', block.includes('Q-2 是否记住关闭 → 用户选 A'), block)
  check('说明以用户选择为准', block.includes('不要改回推荐答案'))

  // 字母不够时，缺的标成未回答
  const short = buildAnswerBlock(join(dir), 'B')
  check('字母不足时不硬凑（短于 3 个走原样引用）', !short.includes('用户选 B') || short.includes('自然语言'))

  // 自然语言回答不瞎展开
  const natural = buildAnswerBlock(join(dir), '按推荐，但第二个要改成记住')
  check('自然语言走原样引用', natural.includes('用户原话') && natural.includes('自然语言'))

  // 没有回答就不生成段
  check('空回答返回空串', buildAnswerBlock(join(dir), '') === '')

  // 优先用「上一轮 agent 自己提的问题」，不是旧的《待提问清单》
  const decisions = [{ q: '版本号变更是否保留' }, { q: '单测执行方式是否接受' }]
  const byDecisions = buildAnswerBlock(join(dir), 'AA', decisions)
  check('写明是上一轮提问', byDecisions.includes('按上一轮提问的顺序'), byDecisions)
  check('第一条对应 A', byDecisions.includes('第 1 条 版本号变更是否保留 → 用户选 A'), byDecisions)
  check('第二条对应 A', byDecisions.includes('第 2 条 单测执行方式是否接受 → 用户选 A'), byDecisions)
  check('不再混入旧清单的问题', !byDecisions.includes('弹窗时机'), byDecisions)
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
  const { deps, saved, sent, agentCalls, events } = makeDeps()
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: 'welcome modal 首页加个欢迎弹窗', replyTo: 1, st, initiator: { userId: 'u1', nickname: '产品' } })

  const flow = saved.get('g1').flow
  check('生成了随机需求标识', /^[a-z0-9]{8}$/.test(flow.reqId), flow.reqId)
  check('name 是原文截断', String(flow.name).includes('welcome'), flow.name)
  check('停在需求澄清等用户', flow.status === 'waiting_user', flow.status)
  check('只跑了一个 agent 回合', agentCalls.length === 1, String(agentCalls.length))
  check('回合是 req-questions', agentCalls[0].id === 'req-questions')
  check('首次会话是新起（无 sessionId）', agentCalls[0].sessionId === null)
  check('播报受理', sent.some((t) => t.includes('开始处理')))
  check('播报阶段完成', sent.some((t) => t.includes('需求澄清阶段已完成')))
  check('播报在等用户', sent.some((t) => t.includes('需求澄清阶段已完成')))
  // 等用户拍板改成发提问卡片，不再是「回复「通过」」那种纯文本
  const ask = events.find((e) => e.kind === 'ask')
  check('等用户时发提问卡片', Boolean(ask), JSON.stringify(events))
  check('卡片结构正确', ask?.payload?.questions?.length >= 1 && ask.payload.questions[0].kind === 'single', JSON.stringify(ask?.payload))
  check('需求绑进群状态', saved.get('g1').reqId === flow.reqId, `${saved.get('g1').reqId} vs ${flow.reqId}`)
}

console.log('\n== 用户回答：需求定稿并复用会话 ==')
{
  // 这个用例验证的是「回答后一路推进到收尾」，人工逐阶段确认会打断它
  const { deps, saved, sent, agentCalls, logs } = makeDeps({ approval: 'auto' })
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: 'welcome modal 首页加个欢迎弹窗', replyTo: 1, st })
  const afterFirst = saved.get('g1')

  try {
    await bridge.handleMessage({ groupId: 'g1', text: '1. 首次启动 2. 记住关闭 3. 用这句文案', replyTo: 2, st: afterFirst, initiator: null })
  } catch (e) {
    console.log('  [调试] handleMessage 抛错:', e.message)
  }

  const flow = saved.get('g1').flow
  check('定稿回合拿到了用户回答', flow.vars.userAnswer.includes('首次启动'), flow.vars.userAnswer)
  check('定稿复用需求 agent 会话', agentCalls[1].sessionId === 'sid-req-questions', String(agentCalls[1].sessionId))
  check('后续进入设计', agentCalls[2]?.id === 'design', agentCalls[2]?.id)
  check('设计用新会话', agentCalls[2]?.sessionId === null)
  // 合并是开发回合，跑完直接收尾
  // merge 已改回 agent 回合，mock 会把它当普通阶段跑完
  check('合并回合跑完', flow.status === 'done' || flow.current === 'merge', `${flow.status} / ${flow.current}`)
  check('合并回合被派给 agent', agentCalls.some((c) => c.id === 'merge'), agentCalls.map((c) => c.id).join(' → '))
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

console.log('\n== agent 要用户拍板：把它做成提问卡片 ==')
{
  const { deps, saved, sent, events } = makeDeps({
    replyPlan: {
      'req-questions': { receipt: { status: 'needs_input', decisions: [{ q: '弹窗时机？', options: [{ text: '首次启动', recommended: true }] }] } },
    },
  })
  const bridge = createFlowBridge(deps)
  await startReq(bridge, { text: 'welcome modal 加弹窗', replyTo: 5, st: newState() })

  const flow = saved.get('g1').flow
  check('状态 waiting_user', flow.status === 'waiting_user')
  check('问题进 waiting', flow.waiting.decisions.length === 1)
  const ask = events.find((e) => e.kind === 'ask')?.payload
  check('群里看到了问题', Boolean(ask?.questions?.[0]?.title?.includes('弹窗时机')), JSON.stringify(ask))
  check('选项带推荐标记', ask?.questions?.[0]?.options?.[0]?.label === '首次启动（推荐）', JSON.stringify(ask?.questions?.[0]?.options))
  check('留了自由输入的口子', ask?.questions?.[0]?.allowInput === true)
  check('不再发纯文本列表', !sent.some((t) => t.includes('A. 首次启动')), sent.join(' / '))
}

console.log('\n== 提问卡片：通过/打回 + 结构化回答 ==')
{
  const confirm = askPayloadFor([])
  check('没有决策项时给通过/打回', confirm.questions[0].id === 'confirm' && confirm.questions[0].options.length === 2, JSON.stringify(confirm))
  check('打回能填理由', confirm.questions[0].allowInput === true && /打回理由/.test(confirm.questions[0].inputLabel), JSON.stringify(confirm.questions[0]))
  check('标题带上当前阶段', confirm.title.includes('确认'), confirm.title)

  const picked = askPayloadFor([{ q: '先做哪个', options: [{ text: '登录' }, { text: '首页' }] }], 'x')
  check('决策卡片一个问题', picked.questions.length === 1 && picked.questions[0].title === '先做哪个', JSON.stringify(picked))
  check('选项编号是字母', picked.questions[0].options[1].id === 'b' && picked.questions[0].options[1].label === '首页', JSON.stringify(picked.questions[0].options))

  const titled = askPayloadFor([{ q: '先做哪个', options: [{ text: '登录' }] }], 'x', '选个先做的页面')
  check('决策卡片用调用方标题', titled.title === '选个先做的页面', titled.title)
  const noTitle = askPayloadFor([{ q: '先做哪个', options: [{ text: '登录' }] }])
  check('没传标题落回默认文案', noTitle.title === '需要你拍板', noTitle.title)
  const blankTitle = askPayloadFor([{ q: '先做哪个', options: [{ text: '登录' }] }], 'x', '   ')
  check('空白标题也算没传', blankTitle.title === '需要你拍板', blankTitle.title)

  const dec = [{ q: '弹窗时机？', options: [{ text: '首次启动' }, { text: '每次启动' }] }]
  const block = buildAnswerBlock(repoRoot, '', dec, [{ qid: 'q1', optionIds: ['b'], input: '再补一句：能关掉' }])
  check('回答块按勾选还原成文字', block.includes('弹窗时机？ → 每次启动') && block.includes('能关掉'), block)

  const confirmBlock = buildAnswerBlock(repoRoot, '', [], [{ qid: 'confirm', optionIds: ['reject'], input: '按钮颜色不对' }])
  check('打回理由进回答块', confirmBlock.includes('打回') && confirmBlock.includes('按钮颜色不对'), confirmBlock)

  const approveBlock = buildAnswerBlock(repoRoot, '', [], [{ qid: 'confirm', optionIds: ['approve'] }])
  check('通过也写清楚', approveBlock.includes('通过'), approveBlock)
}

console.log('\n== 返工不播「完成」 ==')
{
  // 用独立的需求标识，否则上一个用例写过的产物会让「缺失」的校验通过
  const { deps, sent } = makeDeps({ replyPlan: { 'req-questions': { skip: true } } })
  const bridge = createFlowBridge(deps)
  await startReq(bridge, { text: 'retrycase 加弹窗', replyTo: 6, st: newState() })
  check('没有阶段完成消息', !sent.some((t) => t.includes('需求澄清阶段已完成')), sent.join(' / '))
}

console.log('\n== 卡住后用户说一句，重新试 ==')
{
  const { deps, saved, sent } = makeDeps({
    replyPlan: { 'req-questions': { receipt: { status: 'blocked', blockers: [{ reason: '缺设计参照截图' }] } } },
  })
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: 'welcome modal 加弹窗', replyTo: 7, st })
  check('卡住状态', saved.get('g1').flow.status === 'blocked')
  check('群里说明了卡点', sent.some((t) => t.includes('设计参照')))

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
  await startReq(bridge, { text: 'spawnfail 测试', replyTo: 12, st })

  check('报了 dshBin 配置问题', sent.some((t) => t.includes('dshBin')), sent.join(' / '))
  check('没有当成阶段完成播报', !sent.some((t) => t.includes('阶段已完成')))
  check('没有走三次返工', !sent.some((t) => t.includes('连续 3 轮')))
}

console.log('\n== 群消息不再起需求：只回提示 ==')
{
  // v2 起需求只走 App 的「新需求」弹窗（POST /api/requirements → createRequirement），
  // 群里说什么都不再建 flow——回一句指路就够了。
  const { deps, saved, sent } = makeDeps()
  const bridge = createFlowBridge(deps)
  await bridge.handleMessage({ groupId: 'g1', text: '   ', replyTo: 10, st: newState(), initiator: null })
  check('空消息也指路到「新需求」按钮', sent.some((t) => t.includes('新需求')), sent.join(' / '))

  const st = newState()
  await bridge.handleMessage({
    groupId: 'g1',
    text: '首页加个欢迎弹窗',
    replyTo: 11,
    st,
    initiator: { userId: 'u-member', nickname: '开发小明' },
  })
  check('说需求不再建 flow', !saved.get('g1'), '不应该建 flow')
  check('回了指路提示', sent.some((t) => t.includes('新需求')), sent.join(' / '))
}

console.log('\n== 审计：记录发起人与确认人 ==')
{
  const { deps, saved } = makeDeps({ approval: 'manual' })
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: '加个弹窗', replyTo: 1, st, initiator: { userId: 'u-owner', nickname: '群主' } })
  check('发起人落盘到群状态', saved.get('g1').initiator?.userId === 'u-owner', JSON.stringify(saved.get('g1').initiator))

  await bridge.handleMessage({
    groupId: 'g1',
    text: '通过',
    replyTo: 2,
    st: saved.get('g1'),
    initiator: { userId: 'u-admin2', nickname: '另一个管理员' },
    can: async () => ({ ok: true, role: 'admin' }),
  })
  const flow = saved.get('g1').flow
  check('确认人记录到 flow', flow.confirmer?.userId === 'u-admin2', JSON.stringify(flow.confirmer))
  check('确认人带阶段', flow.confirmer?.stage === 'req-questions', String(flow.confirmer?.stage))
}

console.log('\n== B1/B4：回合执行参数（approval-policy / toolPaths）==')
{
  // 默认 runTurn mock 的产物落盘逻辑先存下来，包一层记下透传参数再转发，
  // 跑一个完整流程看 dev/review 回合分别拿到什么 approvalPolicy。
  const { deps, saved } = makeDeps({ approval: 'auto' })
  const innerRunTurn = deps.runTurn
  const seen = []
  deps.runTurn = async (o) => {
    seen.push({ id: o.prompt.match(/（([\w-]+)）\s*$/m)?.[1] ?? '?', approvalPolicy: o.approvalPolicy })
    return innerRunTurn(o)
  }
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: '加个弹窗', replyTo: 1, st, initiator: { userId: 'u1', nickname: 'n' } })
  // 一路「通过」让流程走完 req-questions → ... → dev
  for (let i = 0; i < 6; i++) {
    await bridge.handleMessage({
      groupId: 'g1', text: '通过', replyTo: 10 + i, st: saved.get('g1'),
      initiator: { userId: 'u1', nickname: 'n' },
      can: async () => ({ ok: true, role: 'admin' }),
    })
  }
  const devCall = seen.find((s) => s.id === 'dev')
  const reviewCall = seen.find((s) => s.id === 'review')
  check('dev 回合带 approval-policy never（要跑构建，无人值守）', devCall?.approvalPolicy === 'never', JSON.stringify(devCall))
  check('review 回合保持默认 ask', reviewCall?.approvalPolicy === 'ask', JSON.stringify(reviewCall))

  // withToolPaths：存在的目录加到 PATH 前面，不存在的忽略
  const dir = mkdtempSync(join(tmpdir(), 'toolpath-'))
  const env = withToolPaths({ PATH: 'C:/original' }, [dir, 'C:/definitely/not/exist'])
  check('存在的工具目录进 PATH 头部', env.PATH.startsWith(dir) && env.PATH.includes('C:/original'), env.PATH)
  check('原 PATH 其余字段原样保留', env.PATH.split(';').length === 2, env.PATH)
  const untouched = withToolPaths({ PATH: 'keep' }, null)
  check('没配 toolPaths 时 env 原样返回', untouched.PATH === 'keep')
  const allMissing = withToolPaths({ PATH: 'keep' }, ['C:/definitely/not/exist'])
  check('全不存在的 toolPaths 不改 PATH', allMissing.PATH === 'keep')
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n== B2.5：环境前置探测（preflightGit）==')
{
  // 正常环境（CI/本机都有 git）：必须 ok，且不抛
  const good = preflightGit()
  check('git 在 PATH 时探测通过', good.ok === true, JSON.stringify(good))

  // PATH 被掏空时必须给出人话报错而不是 ENOENT 原文——
  // 这是这个探测存在的全部意义（真实事故：bot 进程 PATH 没 git，4 轮 0s 失败）
  const cleanPath = process.platform === 'win32' ? 'C:\\definitely-not-a-path' : '/definitely-not-a-path'
  const saved = process.env.PATH
  process.env.PATH = cleanPath
  try {
    const bad = preflightGit()
    check('PATH 没有 git 时探测失败', bad.ok === false, JSON.stringify(bad))
    check('报错是人话且带指路', /PATH/.test(bad.error) && /重启 bot|toolPaths/.test(bad.error), bad.error)
  } finally {
    process.env.PATH = saved
  }
}

console.log('\n== B3：设备预热（warmupAndLease）==')
{
  // 场景一：服务上有关着的模拟器 → 启动 → 等 running → 重新租成功
  {
    let started = null
    let running = false
    const emulator = {
      list: async () => ({
        ok: true,
        items: [{ name: 'avd-cold', running }],
      }),
      start: async (name) => { started = name; running = true; return { ok: true } },
      lease: async () => ({ ok: true, deviceId: 'avd-cold' }),
    }
    const logLines = []
    const r = await warmupAndLease(emulator, {
      reqId: 'req-x', stage: 'dev', platform: 'android',
      log: (m) => logLines.push(m), maxWaitMs: 10_000,
    })
    check('预热后租到设备', r.ok === true && r.deviceId === 'avd-cold', JSON.stringify(r))
    check('启动的是列表里那台离线设备', started === 'avd-cold')
    check('日志说了预热', logLines.some((m) => m.includes('预热')), logLines.join())
  }
  // 场景二：没有离线模拟器 → 不瞎启动，直接报错
  {
    const emulator = {
      list: async () => ({ ok: true, items: [{ name: 'a', running: true }] }),
      start: async () => { throw new Error('不该被调用') },
      lease: async () => ({ ok: false, error: 'x' }),
    }
    const r = await warmupAndLease(emulator, { reqId: 'r', stage: 'dev', platform: 'android' })
    check('全是运行中设备时报「没有可预热的」', !r.ok && r.error.includes('没有可预热'), JSON.stringify(r))
  }
  // 场景三：start 失败 → 原因透传
  {
    const emulator = {
      list: async () => ({ ok: true, items: [{ name: 'bad', running: false }] }),
      start: async () => ({ ok: false, error: '镜像损坏' }),
      lease: async () => ({ ok: false, error: 'x' }),
    }
    const r = await warmupAndLease(emulator, { reqId: 'r', stage: 'dev', platform: 'android' })
    check('启动失败原因透传', !r.ok && r.error.includes('镜像损坏'), JSON.stringify(r))
  }
  // 场景四：启动了但一直不 running → 超时报错
  {
    const emulator = {
      list: async () => ({ ok: true, items: [{ name: 'stuck', running: false }] }),
      start: async () => ({ ok: true }),
      lease: async () => ({ ok: false, error: 'x' }),
    }
    const r = await warmupAndLease(emulator, { reqId: 'r', stage: 'dev', platform: 'android', maxWaitMs: 100 })
    check('一直不就绪按超时报错', !r.ok && r.error.includes('仍未就绪'), JSON.stringify(r))
  }
}

console.log('\n== capDiff：短 diff 原样、长 diff 截到 600 行 ==')
{
  const small = [
    'diff --git a/a.js b/a.js',
    '+++ b/a.js',
    '+x',
  ].join('\n')
  const s = capDiff(small)
  check('短 diff 原样返回', s.diff === small, s.diff)
  check('短 diff 不带截断提示', !s.diff.includes('已截断'))
  check('文件名从 diff 头解析出来', s.changedFiles === 'a.js', s.changedFiles)

  const big = [
    'diff --git a/a.js b/a.js',
    '+++ b/a.js',
    ...Array.from({ length: 800 }, (_, i) => `+line ${i}`),
    '+TAIL_MARKER',
  ].join('\n')
  const b = capDiff(big)
  check('长 diff 尾部被切掉', !b.diff.includes('TAIL_MARKER'))
  check('保留前 600 行', b.diff.includes('+line 596') && !b.diff.includes('+line 600'))
  check('明说已截断', /超过 600 行已截断/.test(b.diff), b.diff.slice(-120))
  check('给出按文件取的办法', /git diff -- <文件>/.test(b.diff))
  check('空 diff 不抛错', capDiff('').changedFiles.includes('无法'), capDiff('').changedFiles)
}

console.log('\n== diff 预注入：评审链拿到真实 diff，其他阶段不受影响 ==')
{
  // gitDiff mock 返回带标准头的 diff：要能从里面解出文件名
  const { deps, saved, agentCalls } = makeDeps({ approval: 'manual' })
  // 前 7 行是标准头，后面追加 700 行填充 + 一行尾部标记：
  // 用来验证「超过 600 行就截断、尾部内容不再进 prompt」。
  const diffHeader = [
    'diff --git a/app/lib/old.dart b/app/lib/new.dart',
    'index 1111..2222 100644',
    '--- a/app/lib/old.dart',
    '+++ b/app/lib/new.dart',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ]
  deps.gitDiff = () => [
    ...diffHeader,
    ...Array.from({ length: 700 }, (_, i) => `+filler line ${i}`),
    '+TAIL_SHOULD_NOT_APPEAR',
  ].join('\n')
  const innerRunTurn = deps.runTurn
  const prompts = []
  deps.runTurn = async (o) => {
    prompts.push(o.prompt)
    return innerRunTurn(o)
  }
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: '加个弹窗', replyTo: 1, st, initiator: { userId: 'u1', nickname: 'n' } })
  // 走到 dev：req-questions 等用户回答，此后 req-prd/design/tech-plan 每阶段都要「通过」
  for (let i = 0; i < 5; i++) {
    await bridge.handleMessage({
      groupId: 'g1', text: '通过', replyTo: 10 + i, st: saved.get('g1'),
      initiator: { userId: 'u1', nickname: 'n' },
      can: async () => ({ ok: true, role: 'admin' }),
    })
  }
  const ids = agentCalls.map((c) => c.id)
  const devIdx = ids.indexOf('dev')
  check('流程走到 dev', devIdx >= 0, ids.join(','))
  if (devIdx >= 0) {
    // dev 的 prompt 不该带 diff 内容（它自己就是写代码的，input 里也没有 <diff>）
    check('dev prompt 不含 diff 注入', !prompts[devIdx].includes('diff --git a/app/lib/old.dart'), prompts[devIdx].slice(0, 200))
    // 再走一轮「通过」进 review：评审链的 prompt 该带上真实 diff 和文件名
    await bridge.handleMessage({
      groupId: 'g1', text: '通过', replyTo: 20, st: saved.get('g1'),
      initiator: { userId: 'u1', nickname: 'n' },
      can: async () => ({ ok: true, role: 'admin' }),
    })
    const reviewIdx = agentCalls.findIndex((c) => c.id === 'review')
    check('流程进了 review（评审链免确认直通）', reviewIdx > devIdx, agentCalls.map((c) => c.id).join(','))
    if (reviewIdx > devIdx) {
      check('review prompt 含 diff 内容', prompts[reviewIdx].includes('diff --git a/app/lib/old.dart'), prompts[reviewIdx].slice(0, 300))
      check('review prompt 含改动文件名', prompts[reviewIdx].includes('app/lib/new.dart'), prompts[reviewIdx].slice(0, 300))
      check('review prompt 无残留占位符', !prompts[reviewIdx].includes('<changedFiles>') && !prompts[reviewIdx].includes('<diff>'))
      check('超长 diff 被截断（600 行后的内容不再内联）', !prompts[reviewIdx].includes('TAIL_SHOULD_NOT_APPEAR'))
      check('截断时告诉它按文件单独取', /git diff -- <文件>/.test(prompts[reviewIdx]), prompts[reviewIdx].slice(-300))
    }
  }
}

console.log('\n== 收尾兜底：worktree 约定路径找回落盘文档 ==')
{
  // 上轮实测：wrapup 时 flow.workDir 丢了、vars.mergeWorkDir 也空着，但
  // 工作区本体（<worktreeRoot>/<reqId>）还健在，文档就在里面。兜底要能
  // 按约定路径找回来，不再停在「缺产物，手工拷」。
  const { backfillFinalArtifacts } = await import('../src/flow-bridge.js')
  const reqId = 'reqWT1'
  const scratch = join(repoRoot, 'scratch', reqId)
  mkdirSync(scratch, { recursive: true })
  const wtRoot = join(repoRoot, 'wts')
  const wtReqDir = join(wtRoot, reqId, 'docs/requirements', reqId)
  mkdirSync(wtReqDir, { recursive: true })
  // 工作区里有 3 份文档，scratch 里另有一份已回收的（不算缺）
  for (const f of ['需求卡片.md', 'PRD.md', '技术方案.md']) {
    writeFileSync(join(wtReqDir, f), '工作区版本')
  }
  writeFileSync(join(scratch, '测试报告.md'), '已在')
  const flow = { reqId, workDir: null, vars: {} } // 模拟 wrapup 时 workDir 已丢
  const config = { primaryRepo: { worktreeRoot: wtRoot } }
  const recovered = backfillFinalArtifacts(scratch, flow, config)
  check('三份文档从约定路径找回', JSON.stringify(recovered.slice().sort()) === JSON.stringify(['PRD.md', '技术方案.md', '需求卡片.md']), JSON.stringify(recovered))
  check('已回收的不重复拷', !recovered.includes('测试报告.md'), JSON.stringify(recovered))
  check('拷回来的内容对', readFileSync(join(scratch, 'PRD.md'), 'utf8') === '工作区版本')
  // 工作区目录也不存在时：安静返回空列表，让收尾检查报缺（不抛）
  const flow2 = { reqId: 'reqNONE', workDir: null, vars: {} }
  const none = backfillFinalArtifacts(join(repoRoot, 'scratch', 'reqNONE'), flow2, config)
  check('约定路径也空时返回空列表', JSON.stringify(none) === '[]', JSON.stringify(none))
  // workDir 记着时优先用它（agent 干活的地方最全），约定路径只是兜底
  const wtDev = join(wtRoot, 'reqWT2', 'docs/requirements', 'reqWT2')
  mkdirSync(wtDev, { recursive: true })
  writeFileSync(join(wtDev, '验收文档.md'), 'dev 版')
  const flow3 = { reqId: 'reqWT2', workDir: join(wtRoot, 'reqWT2'), vars: { mergeWorkDir: null } }
  const rec3 = backfillFinalArtifacts(join(repoRoot, 'scratch', 'reqWT2'), flow3, config)
  check('workDir 优先命中', JSON.stringify(rec3) === JSON.stringify(['验收文档.md']), JSON.stringify(rec3))
}

console.log('\n== merge 失败重试：合并锁立刻归还，不让下一轮干等 TTL ==')
{
  // 上轮实测：merge 连吃两次 Connection error 后，第三次不是马上跑的——
  // 中间隔了 4 分 41 秒。根因是 onCheckpointEnd 对 retry 提前 return，
  // 把尾部的锁释放一起跳过了，第二回合只能等第一回合的锁 TTL（5 分钟）
  // 过期后被当僵尸抢走。修复后锁随回合结束立刻归还。
  const { deps, saved, agentCalls, logs } = makeDeps({ approval: 'auto' })
  let mergeFails = 2
  const origRunTurn = deps.runTurn
  deps.runTurn = async (args) => {
    // bridge 调 runTurn 不带 checkpoint 对象，mock 是从 prompt 正则抓 id 的，
    // 这里也照做；失败回合没有走 mock，agentCalls 要自己补一笔
    const id = args.prompt.match(/【本回合只做这一步】.*（([\w-]+)）/)?.[1]
    if (id === 'merge' && mergeFails > 0) {
      mergeFails--
      agentCalls.push({ id, sessionId: null })
      return { ok: false, sessionId: 'sid-merge', error: 'Connection error.' }
    }
    return origRunTurn(args)
  }
  const bridge = createFlowBridge(deps)
  const st = newState()
  const t0 = Date.now()
  await startReq(bridge, { text: 'welcome modal 首页加个欢迎弹窗', replyTo: 1, st })
  // req-questions 是 waitUser 回合，auto 模式也要等用户回答后才往下走
  const afterFirst = saved.get('g1')
  await bridge.handleMessage({ groupId: 'g1', text: '1. 首次启动 2. 记住关闭 3. 用这句文案', replyTo: 2, st: afterFirst, initiator: null })
  const wall = Date.now() - t0
  const mergeCalls = agentCalls.filter((c) => c.id === 'merge').length
  check('merge 跑了 3 次（2 失败 + 1 成功）', mergeCalls === 3, agentCalls.map((c) => c.id).join(','))
  check('失败回合立即归还合并锁（日志可见）', logs.filter((l) => l.includes('已释放合并锁')).length === 3, logs.filter((l) => l.includes('合并锁')).join(' | '))
  check('重试没有等锁 TTL（全程 < 45s：两次失败各含 ~10s 回执落盘轮询，修复前要干等 5 分钟）', wall < 45_000, `${wall}ms`)
  if (fail) console.log('    [调试] logs:\n' + logs.map((l) => '      ' + l).join('\n'))
  check('流程最终完成', saved.get('g1').flow.status === 'done', saved.get('g1').flow.status)
}

console.log('\n== merge 验证判据：fast-forward 免编译单测，main 动过必跑 ==')
{
  const { deps, saved, agentCalls, logs } = makeDeps({ approval: 'auto' })
  const prompts = []
  const innerRunTurn = deps.runTurn
  deps.runTurn = async (o) => {
    prompts.push(o.prompt)
    return innerRunTurn(o)
  }
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: 'welcome modal 首页加个欢迎弹窗', replyTo: 1, st })
  const afterFirst = saved.get('g1')
  await bridge.handleMessage({ groupId: 'g1', text: '1. 首次启动 2. 记住关闭 3. 用这句文案', replyTo: 2, st: afterFirst, initiator: null })
  const flow = saved.get('g1').flow
  check('判据算进状态', flow.vars.mergeFastForward === true, String(flow.vars.mergeFastForward))
  const mergeIdx = agentCalls.findIndex((c) => c.id === 'merge')
  // 夹具里 feature 分支从 main 直接开出、agent 不动 main → fast-forward
  check('merge prompt 写明跳过编译单测', prompts[mergeIdx]?.includes('跳过编译和单元测试'), prompts[mergeIdx]?.slice(-400))
  check('判据日志可见', logs.some((l) => l.includes('合并验证判据') && l.includes('没有新提交')), logs.filter((l) => l.includes('判据')).join(' | '))
}

console.log('\n== 回执读不到时，校验失败要随播报发到群里，不能只进日志 ==')
{
  // 真实事故：merge 回执写错工作区，bot 读不到回执（verifyReason='没有写
  // _receipt-merge.json'），但回合成功、产物校验也过，群里照样只播「阶段已完成」
  // ——用户看着一切正常。校验失败必须跟着播报一起出去。
  // 构造：回合 ok + 产物都在，只把 req-prd 的回执文件删掉——这正是「校验通过、
  // 回执丢失、流程照常推进」的那条路径（verify 不过会走 retry，不播报，另条路）。
  const { deps, saved, sent } = makeDeps({ approval: 'auto' })
  const inner = deps.runTurn
  deps.runTurn = async (o) => {
    const r = await inner(o)
    // 抠 reqDir 的正则与 mock（119 行）同款：outDir 可能含空格，「写到：」后的整行才是路径
    const m = o.prompt.match(/- 文档（[^\n]*写到：(.+)/)?.[1]?.trim()
    if (m && o.prompt.includes('【本回合只做这一步】') && /（req-prd）/.test(o.prompt)) {
      const receiptPath = join(m, receiptFile('req-prd'))
      if (existsSync(receiptPath)) rmSync(receiptPath, { force: true })
    }
    return r
  }
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: 'welcome modal 首页加个欢迎弹窗', replyTo: 1, st })
  const afterFirst = saved.get('g1')
  await bridge.handleMessage({ groupId: 'g1', text: '1. 首次启动 2. 记住关闭 3. 用这句文案', replyTo: 2, st: afterFirst, initiator: null })
  const warns = sent.filter((t) => t.includes('产物校验不通过'))
  check('回执缺失随播报发到群里', warns.length >= 1, JSON.stringify(sent.filter((t) => t.includes('阶段已完成')).slice(0, 3)))
  check('播报带「没有写 _receipt」原因', warns.some((t) => t.includes('_receipt-req-prd')), warns[0])
  check('播报同时保留了「阶段完成」原文', warns.every((t) => t.includes('阶段已完成')), warns[0])
}

console.log('\n== merge 回执写偏：兜底恢复 + reqDir 指向合并工作区 ==')
{
  // 真实事故×2：merge 回合 agent 跑在合并工作区（cwd=_merge），把回执写到
  // _merge 根目录；engine 在开发工作区的 docs/requirements/<reqId>/ 读，
  // 读不到 → 「明明合并完了却报没写回执」。修两层：
  // 1) prompt 的 reqDir（产物+回执位置）在 merge 回合指到合并工作区；
  // 2) 读侧兜底 recoverMergeReceipt：正规目录没有时去已知位置搬回来。
  const { recoverMergeReceipt, reqDirOf } = await import('../src/flow-bridge.js')
  const flow = {
    reqId: 'reqMR1',
    workDir: join(repoRoot, 'wt-reqMR1'),
    vars: { mergeWorkDir: join(repoRoot, 'wt-_merge') },
  }
  const canonicalDir = reqDirOf(flow)
  const canonical = join(canonicalDir, receiptFile('merge'))
  // 场景1：回执写在工作区根（agent 最常见的写偏）
  mkdirSync(flow.vars.mergeWorkDir, { recursive: true })
  writeFileSync(join(flow.vars.mergeWorkDir, receiptFile('merge')), JSON.stringify({ status: 'done', summary: 'ok' }))
  check('正规目录没有回执时 recover 返回 false 前先搬回', recoverMergeReceipt(flow, 'merge') === true)
  check('搬回后正规目录有回执', existsSync(canonical))
  check('搬回的内容对', JSON.parse(readFileSync(canonical, 'utf8')).status === 'done')
  check('非 merge 阶段不兜底', recoverMergeReceipt(flow, 'dev') === false)
  // 场景2：回执在合并工作区的需求目录（prompt 指对时的落点）
  rmSync(canonical, { force: true })
  const mergeReqDir = join(flow.vars.mergeWorkDir, 'docs/requirements', flow.reqId)
  mkdirSync(mergeReqDir, { recursive: true })
  writeFileSync(join(mergeReqDir, receiptFile('merge')), JSON.stringify({ status: 'done', summary: 'ok2' }))
  check('合并工作区需求目录里的回执也能搬回', recoverMergeReceipt(flow, 'merge') === true && existsSync(canonical))
  // 场景3：正规目录本来就有——直接返回 true，不动
  check('正规目录已有回执返回 true', recoverMergeReceipt(flow, 'merge') === true)
  // 场景4：哪里都没有——安静返回 false
  rmSync(canonical, { force: true })
  rmSync(join(flow.vars.mergeWorkDir, receiptFile('merge')), { force: true })
  rmSync(join(mergeReqDir, receiptFile('merge')), { force: true })
  check('哪都没有返回 false', recoverMergeReceipt(flow, 'merge') === false)
  // 场景5：mergeWorkDir 空着（还没进 merge 回合）——不兜底不抛
  check('mergeWorkDir 空时安静返回 false', recoverMergeReceipt({ reqId: 'x', workDir: null, vars: {} }, 'merge') === false)
}

console.log('\n== readReceiptWithRetry：beforeAttempt 兜底钩子 ==')
{
  const { readReceiptWithRetry } = await import('../src/flow/orchestrator.js')
  const dir = join(repoRoot, 'retry-hook')
  mkdirSync(dir, { recursive: true })
  // 第一次读不到（没文件），beforeAttempt 里把文件补上 → 第二次读到
  let called = 0
  const r = await readReceiptWithRetry(dir, 'merge', {
    attempts: 3, intervalMs: 10,
    beforeAttempt: () => {
      called++
      if (called === 2) writeFileSync(join(dir, receiptFile('merge')), JSON.stringify({ status: 'done', summary: 'late' }))
    },
  })
  check('beforeAttempt 补救后能读到回执', r.ok === true && r.receipt.summary === 'late', JSON.stringify(r))
  check('beforeAttempt 被调用了两次', called === 2, String(called))
  // beforeAttempt 抛错不阻塞读取
  const r2 = await readReceiptWithRetry(dir, 'merge', {
    attempts: 1, intervalMs: 10,
    beforeAttempt: () => { throw new Error('boom') },
  })
  check('beforeAttempt 抛错不影响读取', r2.ok === true)
}

console.log('\n== merge 回合 prompt：reqDir 指到合并工作区 ==')
{
  // varsFor 在 merge 回合要把 reqDir 指到合并工作区的需求目录，
  // agent 写回执/归档文档才有正确落点（读侧在 buildCtx.beforeReadReceipt 兜底）
  const { deps, saved, agentCalls } = makeDeps({ approval: 'auto' })
  const prompts = []
  const inner = deps.runTurn
  deps.runTurn = async (o) => { prompts.push(o.prompt); return inner(o) }
  const bridge = createFlowBridge(deps)
  const st = newState()
  await startReq(bridge, { text: 'welcome modal 首页加个欢迎弹窗', replyTo: 1, st })
  const afterFirst = saved.get('g1')
  await bridge.handleMessage({ groupId: 'g1', text: '1. 首次启动 2. 记住关闭 3. 用这句文案', replyTo: 2, st: afterFirst, initiator: null })
  // auto 模式一路推到 merge；mock agent 不会真合并，merge 可能不出现——
  // 有 merge 回合就断言 reqDir，没有就跳过（fast-forward 判据已单测覆盖）
  const mergeIdx = agentCalls.findIndex((c) => c.id === 'merge')
  if (mergeIdx >= 0) {
    const mw = saved.get('g1').flow.vars?.mergeWorkDir ?? ''
    const expect = mw ? join(mw, 'docs/requirements', saved.get('g1').flow.reqId) + '/' : null
    check('merge prompt 的产物目录指到合并工作区', expect !== null && prompts[mergeIdx].includes(expect), prompts[mergeIdx].match(/- 文档（[^\n]*写到：(.+)/)?.[1])
  } else {
    console.log('  ⏭️ 夹具没走到 merge（mock 不真合并），reqDir 断言由 recoverMergeReceipt 覆盖')
  }
}

rmSync(repoRoot, { recursive: true, force: true })

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
