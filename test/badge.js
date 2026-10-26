/**
 * 面板徽章的阶段判断：群状态(waiting) 不等于 阶段完成。
 * 曾经混用 g.status 导致「验收进行中」显示成「验收已完成」。
 */
// 验证徽章逻辑：群状态(waiting) ≠ 阶段状态(已完成)
const cases = [
  { name: '回合在跑',        g: { activeTurn: { elapsedMs: 90000 }, stage: '验收', stageStatus: '进行中' }, want: '验收中', wantDur: true },
  { name: '有等待事项',      g: { activeTurn: null, waitingLabel: '等确认', stage: '验收', stageStatus: '进行中' }, want: '验收等确认' },
  { name: '进行中·回合间隙', g: { activeTurn: null, waitingLabel: '', stage: '验收', stageStatus: '进行中', status: 'waiting' }, want: '验收中' },
  { name: '阶段已完成',      g: { activeTurn: null, waitingLabel: '', stage: '验收', stageStatus: '已完成', status: 'waiting' }, want: '验收已完成' },
  { name: '未绑定需求',      g: { activeTurn: null, waitingLabel: '', stage: null, stageStatus: '未开始', status: 'idle', reqId: null }, want: '未绑定需求' },
  // 关键：验收已完成后 agent 还在跑交付，不能显示「验收中」
  { name: '回合在跑·但阶段已完成', g: { activeTurn: { elapsedMs: 120000 }, stage: '验收', stageStatus: '已完成', status: 'running' }, want: '执行中', wantDur: true },
]

function fmtDur(ms){ if(ms==null||ms<0) return '—'; const t=Math.floor(ms/1000); if(t===0) return '不到1秒'; const d=Math.floor(t/86400),h=Math.floor((t%86400)/3600),m=Math.floor((t%3600)/60),s=t%60; let o=''; if(d)o+=d+'天'; if(h)o+=h+'小时'; if(m)o+=m+'分钟'; if(s)o+=s+'秒'; return o }

function badgeOf(g) {
  const stage = g.stage || ''
  if (g.activeTurn) {
    const running = g.stageStatus === '进行中'
    return { cls: 'b-green', name: running && stage ? `${stage}中` : '执行中', dur: fmtDur(g.activeTurn.elapsedMs) }
  }
  if (g.waitingLabel) return { cls:'b-yellow', name: stage ? `${stage}等确认` : '等确认', dur:'' }
  if (g.stageStatus === '进行中') return { cls:'b-blue', name: stage ? `${stage}中` : '执行中', dur:'' }
  if (g.stageStatus === '已完成') return { cls:'b-gray', name: stage ? `${stage}已完成` : '已全部完成', dur:'' }
  if (!g.reqId) return { cls:'b-gray', name:'未绑定需求', dur:'' }
  return { cls:'b-gray', name:'空闲', dur:'' }
}

let pass=0, fail=0
for (const c of cases) {
  const b = badgeOf(c.g)
  const ok = b.name === c.want && (c.wantDur ? !!b.dur : !b.dur)
  console.log(`  ${ok?'✅':'❌'} ${c.name} → ${b.name}${b.dur?' · '+b.dur:''}${ok?'':`（期望 ${c.want}）`}`)
  ok?pass++:fail++
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail?1:0)
