import { minsText, runningText } from '../src/format.js'

/** 心跳/回执的话术边界：曾经把「阶段刚开始」播成「已进行 0 分钟」 */

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = got === want
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n      得到: ${got}\n      期望: ${want}`}`)
  ok ? pass++ : fail++
}

console.log('== minsText ==')
eq('时间戳缺失 → null（不编 0 分钟）', minsText(0), null)
eq('时间戳 undefined → null', minsText(undefined), null)
eq('10 秒前 → 不到 1 分钟', minsText(Date.now() - 10_000), '不到 1 分钟')
eq('30 秒前 → 不到 1 分钟', minsText(Date.now() - 30_000), '不到 1 分钟')
eq('70 秒前 → 1 分钟', minsText(Date.now() - 70_000), '1 分钟')
eq('9 分钟前 → 9 分钟', minsText(Date.now() - 9 * 60_000), '9 分钟')

console.log('\n== runningText ==')
eq('时长未知时省略时长', runningText('开发', 0), '当前开发阶段进行中。')
eq('不足一分钟说清楚', runningText('开发', Date.now() - 20_000), '当前开发阶段中，已进行 不到 1 分钟。')
eq('正常时长', runningText('开发', Date.now() - 5 * 60_000), '当前开发阶段中，已进行 5 分钟。')

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
