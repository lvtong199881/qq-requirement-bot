/**
 * 回合投喂内容的完整性。
 *
 * 曾经出过事故：排队消息补跑时只传了用户原话、没传 promptBody，
 * 子进程收到空 stdin，dsh 报 `a task is required` 直接异常退出。
 *
 * 这里不启动 bridge，而是断言源码里所有 handleTurn 调用点都带了 payload——
 * 属于「结构断言」，专门防这类漏参回退。
 *   node test/turn-payload.js
 */
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

console.log('\n== buildTurnPayload 存在且被复用 ==')
{
  check('定义了 buildTurnPayload', /function buildTurnPayload\(/.test(src))
  const uses = (src.match(/buildTurnPayload\(/g) || []).length
  // 定义 1 次 + 至少 2 处调用（主流程、排队补跑）
  check('至少两处调用', uses >= 3, `实际 ${uses}`)
}

console.log('\n== 所有 handleTurn 调用都带 promptBody ==')
{
  // 取出每个 handleTurn(...) 调用的参数块（到匹配的收尾）
  const calls = []
  let i = 0
  while ((i = src.indexOf('handleTurn(', i)) !== -1) {
    // 跳过函数定义
    if (src.slice(i - 12, i).includes('function ')) {
      i += 11
      continue
    }
    const start = i + 'handleTurn('.length
    let depth = 1
    let j = start
    while (j < src.length && depth > 0) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') depth--
      j++
    }
    calls.push(src.slice(start, j - 1))
    i = j
  }

  check('找到多个调用点', calls.length >= 3, `实际 ${calls.length}`)

  // 每个调用点要么直接给 promptBody，要么用的 payload 变量里必然带它
  const missing = calls
    .map((c, idx) => ({ idx, ok: /promptBody/.test(c) }))
    .filter((x) => !x.ok)
  check(
    '没有漏传 promptBody 的调用',
    missing.length === 0,
    `第 ${missing.map((m) => m.idx + 1).join(', ')} 个调用没传`,
  )

  const missingAnchor = calls.filter((c) => !/anchor/.test(c)).length
  check('没有漏传 anchor 的调用', missingAnchor === 0, `${missingAnchor} 处缺失`)
}

console.log('\n== 排队补跑重新构造 prompt ==')
{
  const queueBlock = src.slice(src.indexOf('drainQueue'), src.indexOf('drainQueue') + 900)
  check('排队分支调用了 buildTurnPayload', /buildTurnPayload\(/.test(queueBlock))
  check('排队分支传了 promptBody', /promptBody/.test(queueBlock))
  check('排队分支传了 anchor', /anchor/.test(queueBlock))
}

console.log('\n== 需求完成后不再起回合 ==')
{
  check('主流程有 allDone 拦截', /if \(ack\?\.allDone\)/.test(src))
  // 拦截必须在 handleTurn 之前，否则回合已经起了
  const idxAck = src.indexOf('ack?.allDone')
  const idxTurn = src.indexOf('handleTurn(groupId, text', idxAck)
  check('拦截在 handleTurn 之前', idxAck > 0 && idxTurn > idxAck, `ack@${idxAck} turn@${idxTurn}`)
}

console.log('\n== 群消息出口都走模板 ==')
{
  const sendLines = src
    .split('\n')
    .filter((l) => /sendPlain\(groupId,/.test(l))
    .filter((l) => !/async function sendPlain|text, \{ replyTo \}|line, \{ replyTo \}/.test(l))
  const raw = sendLines.filter(
    (l) => !/renderMessage|ack\.text|deniedText|helpText|ambiguousReply/.test(l),
  )
  check('没有硬编码文案的 sendPlain', raw.length === 0, raw.map((l) => l.trim().slice(0, 50)).join(' | '))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
