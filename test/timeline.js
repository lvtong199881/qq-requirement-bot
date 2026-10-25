import { formatDuration, runningText } from '../src/format.js'

/** 心跳/回执的话术边界：曾经把「阶段刚开始」播成「已进行 0 分钟」 */

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const ok = got === want
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n      得到: ${got}\n      期望: ${want}`}`)
  ok ? pass++ : fail++
}

console.log('== formatDuration（X天X小时X分钟X秒）==')
eq('30 秒', formatDuration(30 * 1000), '30秒')
eq('1 分钟 30 秒', formatDuration(90 * 1000), '1分钟30秒')
eq('1 小时 1 分钟 30 秒', formatDuration(3670 * 1000), '1小时1分钟10秒')
eq('1 小时 1 分钟 1 秒', formatDuration(3661 * 1000), '1小时1分钟1秒')
eq('1 天 1 小时 1 分钟 30 秒', formatDuration(90090 * 1000), '1天1小时1分钟30秒')
eq('整小时省略分秒', formatDuration(3600 * 1000), '1小时')
eq('整分钟省略秒', formatDuration(120 * 1000), '2分钟')
eq('跨级省略（1h30s）', formatDuration(3630 * 1000), '1小时30秒')
eq('不足 1 秒', formatDuration(400), '不到1秒')
eq('null → null', formatDuration(null), null)

console.log('\n== runningText ==')
eq('开始时间未知时省略时长', runningText('开发', 0), '当前开发阶段进行中。')
eq('刚起步显示秒', runningText('开发', Date.now() - 30_000), '当前开发阶段中，已进行 30秒。')
eq('分秒组合', runningText('开发', Date.now() - 90_000), '当前开发阶段中，已进行 1分钟30秒。')
eq('时分秒组合', runningText('开发', Date.now() - 3671_000), '当前开发阶段中，已进行 1小时1分钟11秒。')

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
