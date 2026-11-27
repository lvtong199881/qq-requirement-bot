/**
 * 回合提前收工：agent 写完回执后进程挂住时，bridge 不该白等满超时。
 * 用一个「写完回执就挂住」的假 dsh 验证：探针发现回执 → 提前按成功收工，
 * 进程树被终止，不用等 timeoutMs。
 *   node test/runner-early-receipt.js
 */
import { mkdtempSync, writeFileSync, existsSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runTurn } from '../src/runner.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const work = mkdtempSync(join(tmpdir(), 'runner-early-'))
const projectDir = join(work, 'proj')
mkdirSync(projectDir, { recursive: true })

// 假 dsh：读完 stdin 就把回执写好，然后永久挂住（模拟真实 agent 的挂住症状）
const receiptFile = join(projectDir, '_receipt-dev.json')
const childScript = join(work, 'fake-dsh-child.cjs')
writeFileSync(
  childScript,
  [
    "const fs = require('fs')",
    // 回执延迟 1 秒写（模拟收尾耗时），之后进程挂住
    "setTimeout(() => fs.writeFileSync(process.env.EARLY_RECEIPT, JSON.stringify({status:'done',summary:'ok'})), 1000)",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'),
)
const dshBin = join(work, 'fake-dsh.cmd')
// %~dp0 带尾反斜杠，拼出来就是 childScript 的完整路径
writeFileSync(dshBin, ['@echo off', `node "%~dp0fake-dsh-child.cjs"`, ''].join('\r\n'))

const started = Date.now()
let childPid = null
// 假 dsh 要 spawn node（经 cmd.exe），env.PATH 必须保证 cmd 里找得到 node——
// 测试进程自己能跑 node 不代表它 PATH 里有 nodejs 目录（可能是绝对路径拉起的）
const nodeDir = join(process.execPath, '..')
const env = { ...process.env, EARLY_RECEIPT: receiptFile }
if (env.PATH && !env.PATH.includes('nodejs')) env.PATH = `${nodeDir};${env.PATH}`
const r = await runTurn({
  dshBin,
  profile: 'test',
  projectDir,
  prompt: '随便什么 prompt',
  env,
  timeoutMs: 120_000, // 足够长：如果白等超时，测试必然失败
  receiptProbe: () => (existsSync(receiptFile) ? { status: 'done' } : null),
  receiptProbeMs: 500,
  onChild: (child) => { childPid = child.pid },
})
const elapsed = Date.now() - started

check('提前收工被标记', r.settledByReceipt === true, JSON.stringify({ settled: r.settledByReceipt, exitCode: r.exitCode, timedOut: r.timedOut, err: r.errorSummary ?? r.turnError ?? r.stderr?.slice(-300) }))
check('没等满超时（<20s，而不是 120s）', elapsed < 20_000, `${Math.round(elapsed / 1000)}s`)
check('没被记成 timedOut', r.timedOut === false)
check('探针发现前回执确实写了', existsSync(receiptFile))

// fs.watch 比轮询快：兜底轮询故意设成 8s，回执 1s 就落地，
// 靠目录事件该在 4s 内收工；没有 watch 的话要等到 8s 那一次轮询
const t3start = Date.now()
const r3 = await runTurn({
  dshBin,
  profile: 'test',
  projectDir,
  prompt: 'x',
  env: { ...env, EARLY_RECEIPT: join(work, 'watched.json') },
  timeoutMs: 120_000,
  receiptProbe: () => (existsSync(join(work, 'watched.json')) ? { status: 'done' } : null),
  receiptProbeMs: 8_000,
  receiptDir: () => work,
  onChild: () => {},
})
const t3 = Date.now() - t3start
check('目录事件触发的收工也被标记', r3.settledByReceipt === true, JSON.stringify({ settled: r3.settledByReceipt, timedOut: r3.timedOut }))
check('不用等 8s 的兜底轮询（<4s 收工）', t3 < 4_000, `${Math.round(t3 / 100) / 10}s`)

// 对照组：没有探针时同一假 dsh 会白等满超时——证明探针是起作用的那个开关
const t2start = Date.now()
const r2 = await runTurn({
  dshBin,
  profile: 'test',
  projectDir,
  prompt: 'x',
  env: { ...env, EARLY_RECEIPT: join(work, 'never-used.json') },
  timeoutMs: 3_000, // 短超时当对照组的「白等」上限
  onChild: () => {},
})
const t2 = Date.now() - t2start
check('对照组：无探针时走到超时强杀', r2.timedOut === true && t2 >= 2_500, `${Math.round(t2 / 1000)}s timedOut=${r2.timedOut}`)

// 清理容忍失败：超时强杀的假 dsh 可能还没死透、句柄未释放，rmSync 会 EPERM——
// 目录在 %TEMP% 下，残留无害，不把清理失败算进测试结果
try {
  rmSync(work, { recursive: true, force: true })
} catch {
  console.log('  （临时目录清理被占用跳过，无害残留）')
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
