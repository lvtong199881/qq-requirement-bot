import { validateGraph, renderMermaid, renderAdjacency } from '../src/flow/graph.js'
import { CHECKPOINTS, EDGES, FIRST_CHECKPOINT } from '../src/flow/flow.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} — ${detail}`) }
}

console.log('\n== 启动自检：当前图合法 ==')
{
  let threw = null
  try { validateGraph() } catch (e) { threw = e }
  check('validateGraph 不抛', threw === null, threw?.message)
}

console.log('\n== 校验能抓住配错的图 ==')
{
  // 临时篡改 EDGES 不可行（const 数组引用仍可 push），用独立副本模拟各问题
  const ids = new Set(CHECKPOINTS.map((c) => c.id))
  check('当前图所有边端点合法', EDGES.every((e) => ids.has(e.from) && ids.has(e.to)))
  // 指向不存在节点：构造一条坏边让 validateGraph 报错
  const bad = [...EDGES, { from: 'dev', to: 'no-such-node', when: 'auto' }]
  // graph.js 读的是 flow.js 的 EDGES 引用——为了测校验逻辑，直接对 collectIssues 的行为做
  // 等价检查：手动把坏边塞进 EDGES（数组可变），跑完再删掉
  EDGES.push({ from: 'dev', to: 'no-such-node', when: 'auto' })
  let threw = null
  try { validateGraph() } catch (e) { threw = e }
  EDGES.pop()
  check('坏边被抓住', threw !== null && /no-such-node/.test(threw.message), threw?.message)

  // 未注册守卫
  EDGES.push({ from: 'dev', to: 'review', when: 'noSuchGuard' })
  threw = null
  try { validateGraph() } catch (e) { threw = e }
  EDGES.pop()
  check('未注册守卫被抓住', threw !== null && /noSuchGuard/.test(threw.message), threw?.message)

  // 死节点（有入边无出边且非终点）：给 design 加个「无出边」状态——删光它的出边
  const saved = EDGES.splice(EDGES.findIndex((e) => e.from === 'design'), 1)
  threw = null
  try { validateGraph() } catch (e) { threw = e }
  EDGES.push(...saved)
  check('死节点被抓住', threw !== null, threw?.message ?? '没抛')
}

console.log('\n== 渲染 ==')
{
  const m = renderMermaid()
  check('mermaid 有 flowchart 头', m.startsWith('flowchart TD'))
  check('12 个节点都画了', CHECKPOINTS.every((c) => m.includes(`["${c.label}"]`) || m.includes(`(["${c.label}"])) `)), '')
  check('13 条边都画了', EDGES.every((e) => m.includes(`${e.from} -->`)), '')
  check('wrapup 画成终端形', m.includes('(["收尾"])'), '')
  const adj = renderAdjacency()
  check('邻接表含起点', adj.includes(FIRST_CHECKPOINT))
  check('邻接表含守卫标注', adj.includes('[waitUser]'))
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
