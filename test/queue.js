/**
 * 排队消息的持久化。
 *
 * 内存队列在 bridge 重启后会丢，所以 enqueue 同时落盘，
 * 下次启动能读到并提示用户重发。
 *   node test/queue.js
 */
import { SessionStore, GroupStateMachine } from '../src/state.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'queue-'))
const cfg = { repoRoot: root, projectDir: root, groupPolicy: { mode: 'auto' }, approval: 'manual' }
const store = new SessionStore(root)
const machine = new GroupStateMachine(cfg, store)
const G = '123456'

store.save(G, { groupId: G, projectDir: root, status: 'running', sessionId: 's1' })

console.log('\n== 排队会落盘 ==')
{
  machine.enqueue(G, '提交')
  machine.enqueue(G, '通过')
  const pending = machine.pendingQueued(G)
  check('state 文件里有 2 条', pending.length === 2, JSON.stringify(pending))
  check('顺序与内容正确', pending.join('|') === '提交|通过', pending.join('|'))
}

console.log('\n== 模拟重启：新实例读得到 ==')
{
  const store2 = new SessionStore(root)
  const machine2 = new GroupStateMachine(cfg, store2)
  const p2 = machine2.pendingQueued(G)
  check('新实例读到 2 条', p2.length === 2, JSON.stringify(p2))
  machine2.clearQueued(G)
  check('清空后为 0', machine2.pendingQueued(G).length === 0)
}

console.log('\n== drainQueue 连落盘一起清 ==')
{
  machine.drainQueue(G) // 先把内存里残留的清掉
  machine.enqueue(G, 'a')
  machine.enqueue(G, 'b')
  check('落盘有 2 条', machine.pendingQueued(G).length === 2)

  const drained = machine.drainQueue(G)
  check('取出 2 条', drained.length === 2, JSON.stringify(drained))
  check('内容正确', drained.join('|') === 'a|b', drained.join('|'))
  check('落盘也清了', machine.pendingQueued(G).length === 0)
}

console.log('\n== 没有 state 文件时排队不炸 ==')
{
  const orphan = '999999'
  let err = null
  try {
    machine.enqueue(orphan, 'x')
  } catch (e) {
    err = e
  }
  check('不抛错', err === null, err?.message)
  check('没有残留落盘', machine.pendingQueued(orphan).length === 0)
}

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
