/**
 * 新群不该认领别人的需求。
 *
 * 事故：拉一个新群进来，@ 一下，bot 回「本需求已全部完成」。
 * 根因是 state.peek 不返回 reqId，所有判定退化成「读最近改动的编排记录」，
 * 而项目里恰好有一个已收尾的需求，新群就被锚到它身上了。
 *
 *   node test/fresh-group.js
 */
import { isFreshGroup, groupStageTable, recoverReqId, stageInfoFor, ackFor, planStageAnnounce } from '../src/stage.js'
import { SessionStore, GroupStateMachine } from '../src/state.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'fresh-group-'))
const reqDir = join(root, 'docs/requirements/old-done')
mkdirSync(reqDir, { recursive: true })

// 一个「已完全收尾」的历史需求：这正是新群被误判成它的原因
writeFileSync(
  join(reqDir, '编排记录.md'),
  [
    '# 编排记录：old-done',
    '',
    '## 阶段进度',
    '| 阶段 | 状态 | 返工次数 | 校验结论 |',
    '| --- | --- | --- | --- |',
    '| 1 产品需求 | 已完成 | 0 | ok |',
    '| 7 验收 | 已完成 | 0 | ok |',
    '| 9 需求收尾 | 已完成 | 0 | ok |',
    '',
    '## 收尾结论',
    '- 判定：通过',
    '- 结论：需求完成',
    '',
  ].join('\n'),
)

/** 从没跑过回合的新群 */
const fresh = {
  groupId: '999',
  projectDir: root,
  reqId: null,
  sessionId: null,
  turn: 0,
  status: 'idle',
  stage: null,
  stageStartedAt: 0,
  waitingLabel: '',
  finishedStages: null,
}

console.log('\n== 新群识别 ==')
check('isFreshGroup：全新群为 true', isFreshGroup(fresh))
check('groupStageTable：新群不读别人的编排记录', groupStageTable(fresh).stages.length === 0)
check('recoverReqId：新群不猜需求', recoverReqId(fresh) === null)

console.log('\n== 新群 @ 一下：不能回「已全部完成」 ==')
{
  const ack = ackFor(fresh, 'content')
  check('不是 allDone', !ack.allDone, JSON.stringify(ack))
  check('文案不含「全部完成」', !ack.text.includes('全部完成'), ack.text)
  check('不绑定别人的需求', ack.reqIdToBind === null, String(ack.reqIdToBind))
}

console.log('\n== 新群提需求：回执要说「接下了」，不能说「没有进行中的阶段」 ==')
{
  const ack = ackFor(fresh, 'content', undefined, { hasContent: true })
  check('回 kickoff 文案', ack.text.includes('接下'), ack.text)
  check('不再说「没有进行中的阶段」', !ack.text.includes('没有进行中'), ack.text)
  check('不算空状态（不补引导）', ack.idle === false, String(ack.idle))
  check('标记 kickoff（调用方据此补阶段播报）', ack.kickoff === true, JSON.stringify(ack))
}

console.log('\n== 只 @ 不说话：仍回空状态 + 引导 ==')
{
  const ack = ackFor(fresh, 'content', undefined, { hasContent: false })
  check('回空状态文案', ack.text.includes('没有进行中'), ack.text)
  check('标记为空状态', ack.idle === true, String(ack.idle))
  check('不标记 kickoff', !ack.kickoff, JSON.stringify(ack))
  const other = ackFor(fresh, 'continue', undefined, { hasContent: true })
  check('非提需求的意图仍回空状态', other.text.includes('没有进行中'), other.text)
}

console.log('\n== 新群不补报历史阶段 ==')
{
  const planned = planStageAnnounce(fresh)
  check('没有阶段消息', planned.messages.length === 0, planned.messages.join('|'))
  check('不写入 finishedStages 污染', planned.patch.finishedStages === undefined, JSON.stringify(planned.patch))
}

console.log('\n== 老群状态丢了 reqId：仍能自愈（不能把老能力一起改掉） ==')
{
  const recovered = { ...fresh, groupId: '888', turn: 7, sessionId: 'sid-1' }
  check('isFreshGroup：跑过回合的群为 false', !isFreshGroup(recovered))
  check('recoverReqId：从编排记录恢复', recoverReqId(recovered) === 'old-done', String(recoverReqId(recovered)))
  const ack = ackFor(recovered, 'content')
  check('老群仍认得出已完成', ack.allDone === true, JSON.stringify(ack))
  check('老群回执指出需求标识', ack.text.includes('old-done'), ack.text)
}

console.log('\n== 已绑定的群照常读自己的阶段表 ==')
{
  const bound = { ...fresh, groupId: '777', turn: 2, sessionId: 'sid-2', reqId: 'old-done' }
  check('isFreshGroup：已绑定为 false', !isFreshGroup(bound))
  check('groupStageTable 能读到阶段', groupStageTable(bound).stages.length > 0)
  const planned = planStageAnnounce(bound)
  check('首次观测不补报历史', planned.messages.length === 0, planned.messages.join('|'))
}

console.log('\n== 新群说「新需求」：不该被 groupTaken 挡住 ==')
{
  // index.js 里判定用 st.reqId || recoverReqId(st)，两者都应为空
  check('符合受理条件', !(fresh.reqId || recoverReqId(fresh)))
}

console.log('\n== 旧版本写脏的群状态：读盘时自动丢弃（不用人工清 .state） ==')
{
  const repo = mkdtempSync(join(tmpdir(), 'fresh-state-'))
  mkdirSync(join(repo, '.state'), { recursive: true })
  // 真实事故现场：turn=0、没有 session，却被写入了别人的 reqId 和满阶段
  writeFileSync(
    join(repo, '.state/group-555.json'),
    JSON.stringify({
      groupId: '555',
      projectDir: root,
      reqId: 'old-done',
      turn: 0,
      sessionId: null,
      status: 'idle',
      stage: '需求收尾',
      finishedStages: ['产品需求', '验收', '需求收尾'],
    }),
  )

  const store = new SessionStore(repo)
  const machine = new GroupStateMachine(
    { projectDir: root, approval: 'manual', groups: [], groupPolicy: { mode: 'auto' }, excludeGroups: [] },
    store,
  )
  const st = machine.peek('555')
  check('脏 reqId 被丢掉', st.reqId === null, String(st.reqId))
  check('仍被认作新群', isFreshGroup(st))
  check('不会被 groupTaken 挡住',
    !(st.reqId || recoverReqId(st)))
  rmSync(repo, { recursive: true, force: true })
}

console.log('\n== 回合收尾：新群不会把别人的编排记录绑到自己身上 ==')
{
  // 漏过一次：收尾处直接 currentStage(projectDir) 读「最近改动的编排记录」，
  // 新群跑完第一回合就绑上了项目的 reqId，还顺手把 finishedStages 填满，
  // 之后这个群再也发不了新需求。stageInfoFor 是这类取值的唯一入口。
  const fresh = { reqId: null, turn: 0, sessionId: null, projectDir: root, finishedStages: null }
  const info = stageInfoFor(fresh)
  check('新群不返回 reqId', info.reqId === null, String(info.reqId))
  check('新群不返回阶段', info.stage === null, String(info.stage))
  check('与 recoverReqId 一致', recoverReqId(fresh) === null)

  // 已绑定的群必须照常读编排记录，不能被新群隔离误伤。
  // 注意 st.reqId 永远优先（调用方写的都是 st.reqId || stageInfoFor().reqId）。
  const bound = { reqId: 'demo', turn: 3, sessionId: 's1', projectDir: root, finishedStages: [] }
  check('已绑定群不被当成新群', !isFreshGroup(bound))
  check('已绑定群保留自己的 reqId', (bound.reqId || stageInfoFor(bound).reqId) === 'demo')
}

rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
