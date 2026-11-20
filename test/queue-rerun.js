/**
 * 回合进行中插话，回合结束后必须补跑。
 *
 * 真实事故：一个回合跑了 31 分钟，用户中途发的两条「继续」进了队列，
 * 回合结束后两条都没执行，日志里也没有任何痕迹——界面上看着就是 bot 没反应。
 * 这里用假 dsh 复现该场景，确保队列一定被消费。
 *
 * 判据为什么是「假 dsh 收到的 prompt」而不是某句日志：
 * 原先断言的是 `日志里出现「补跑排队消息」`，但代码里从来没有这行日志
 * （drainQueue 在 src/flow-bridge.js:1034，只调 handleMessage，不打这个标）。
 * 那条断言等于永远失败，等于没测。现在改成看 dsh 真正吃进去的内容——
 * 排队的话只要出现在后续任一回合的 prompt 里，就证明它没被丢掉。
 *
 * 走 App API 注入，不再用 mock OneBot：QQ 通道已经删了，测试也该走真实入口。
 *
 *   node test/queue-rerun.js
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './helpers/bridge.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

const work = mkdtempSync(join(tmpdir(), 'qqrs-rerun-'))
const fakeDsh = join(work, 'fake-dsh.mjs')
const promptsLog = join(work, 'prompts.jsonl')

// 假 dsh：把收到的 stdin 存下来（这样能断言「排队的话真的被送进去了」），
// 睡一会儿再吐一个合法事件流。用睡眠模拟「回合要跑一阵」，
// 好让第二条消息插在它中间，落进队列。
writeFileSync(
  fakeDsh,
  `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(promptsLog)}, JSON.stringify({ prompt: input }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'fake-session' }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'final', text: '做完了 [[DONE]]交付完成' }) + '\\n')
  process.exit(0)
})
process.stdin.resume()
setTimeout(() => process.stdin.emit('end'), ${Number(process.env.FAKE_DSH_DELAY ?? 1200)})
`,
)
chmodSync(fakeDsh, 0o755)

const b = await boot({
  name: 'rerun',
  turnTimeoutMs: 60_000,
  config: { dshBin: fakeDsh },
})

/** 假 dsh 每被调起一次就记一行，值是它收到的 prompt */
const prompts = () => {
  if (!existsSync(promptsLog)) return []
  return readFileSync(promptsLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l).prompt
      } catch {
        return ''
      }
    })
}

try {
  await b.register('测试管理员', 'pass1234')

  const { threadId } = await b.createThread('首页加个欢迎弹窗')
  check('需求已创建', Boolean(threadId))
  check('第一回合已开始', await b.waitFor(() => prompts().length >= 1, 20_000))
  check('第一轮 prompt 里有需求原话', prompts()[0]?.includes('首页加个欢迎弹窗'), '')

  // 插在回合中途：这时 machine.isRunning 为真，应当进队列
  await b.say(threadId, '顺便把按钮改成蓝色')

  check(
    '插话被排队并回了回执',
    await b.waitFor(async () => {
      const texts = await b.texts(threadId)
      return texts.some((t) => t.includes('排队') || t.includes('上一回合'))
    }, 15_000),
    JSON.stringify((await b.texts(threadId)).slice(-3)),
  )

  // 关键断言：排队的话必须出现在后续某个回合的 prompt 里。
  // 只出现"有第二个回合"是不够的——v2 自己会连续跑多个 checkpoint，
  // 那种续跑的 prompt 里没有用户新说的话。
  const reached = await b.waitFor(
    () => prompts().slice(1).some((p) => p.includes('按钮改成蓝色')),
    40_000,
  )
  check('排队的话进了后续回合的 prompt', reached, `共 ${prompts().length} 轮`)

  check('没有静默丢弃的报错', !b.logs().includes('排队消息处理失败'))

  // 用户视角：自己说的话和回执都要在消息流里，否则界面看起来仍是没反应
  const texts = await b.texts(threadId)
  check('排队回执进了消息流', texts.some((t) => t.includes('排队')), JSON.stringify(texts))
  check('用户自己说的话也落了库', texts.some((t) => t.includes('按钮改成蓝色')))
} finally {
  if (fail > 0) {
    console.log('\n--- bridge 日志尾部 ---')
    console.log(b.logs().split('\n').slice(-30).join('\n'))
  }
  await b.stop()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
