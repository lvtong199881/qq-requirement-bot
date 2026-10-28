/**
 * 模拟器管理单测。
 *
 * 真实模拟器启动要几十秒、还会占内存，测试里用一个假 CLI 顶上：
 * 它按参数返回固定的 JSON / 退出码，用来验证解析、状态判断和错误处理。
 * 真机行为（能不能启动）不在这里验，那是上线前的冒烟任务。
 *   node test/emulator.js
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EmulatorManager, createEmulatorManager, PLATFORMS } from '../src/infra/emulator.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'emu-'))

/** 造一个假的 Emulator CLI：list 返回给定 JSON，其他动作返回固定退出码 */
function makeFakeBin(devices, { startExit = 0, stopExit = 0, delExit = 0 } = {}) {
  const file = join(root, `emu-${Math.random().toString(36).slice(2, 8)}.sh`)
  const json = JSON.stringify(devices)
  writeFileSync(
    file,
    `#!/bin/sh
case "$1" in
  -list) echo '${json}' ;;
  -start) exit ${startExit} ;;
  -stop) exit ${stopExit} ;;
  -delete) exit ${delExit} ;;
  *) exit 0 ;;
esac
`,
  )
  chmodSync(file, 0o755)
  return file
}

const SAMPLE = [
  { name: 'Phone A', deviceType: 'phone', productModel: 'Mate 60', 'os.osVersion': 'HarmonyOS 6', isRunning: 'false', instancePath: '/tmp/a' },
  { name: 'Tablet B', deviceType: 'tablet', productModel: 'MatePad', 'os.osVersion': 'HarmonyOS 7', isRunning: 'true', instancePath: '/tmp/b' },
]

console.log('\n== 列表解析 ==')
{
  const bin = makeFakeBin(SAMPLE)
  const mgr = new EmulatorManager({ platform: 'harmony', tools: { bin } })
  const r = mgr.list()
  check('ok', r.ok, r.error)
  check('两个条目', r.items.length === 2)
  check('名称正确', r.items[0].name === 'Phone A')
  check('类型正确', r.items[1].type === 'tablet')
  check('运行状态正确', r.items[0].running === false && r.items[1].running === true)
  check('平台标注', r.items[0].platform === 'harmony')
  check('平台中文名', r.label === '鸿蒙')

  check('listOnline 只返回运行中的', mgr.listOnline().length === 1)
}

console.log('\n== 命令失败 ==')
{
  const mgr = new EmulatorManager({ platform: 'harmony', tools: { bin: join(root, 'no-such-bin') } })
  const r = mgr.list()
  check('找不到 CLI 时报错', r.ok === false, JSON.stringify(r))
  check('错误说明路径', /找不到模拟器 CLI/.test(r.error ?? ''), r.error)
}

console.log('\n== 启动 ==')
{
  const bin = makeFakeBin(SAMPLE)
  const mgr = new EmulatorManager({ platform: 'harmony', tools: { bin }, bootWaitMs: 1000 })

  // 已运行的不重复启动
  const already = await mgr.start('Tablet B')
  check('已运行 → already', already.ok && already.already === true)

  // 不存在的名字
  const missing = await mgr.start('No Such Device')
  check('不存在的名字报错', !missing.ok && /没有这个模拟器/.test(missing.error), missing.error)

  // 启动后一直没 running → 超时（假 CLI 的 isRunning 永远是 false）
  const timeout = await mgr.start('Phone A')
  check('起不来时报超时', !timeout.ok && /启动超时/.test(timeout.error), timeout.error)
}

console.log('\n== 停止 ==')
{
  const bin = makeFakeBin(SAMPLE, { stopExit: 0 })
  const mgr = new EmulatorManager({ platform: 'harmony', tools: { bin } })
  const r = await mgr.stop('Phone A')
  check('成功', r.ok, r.error)

  const failBin = makeFakeBin(SAMPLE, { stopExit: 1 })
  const mgr2 = new EmulatorManager({ platform: 'harmony', tools: { bin: failBin } })
  const r2 = await mgr2.stop('Phone A')
  check('失败时返回错误', !r2.ok && !!r2.error)
}

console.log('\n== 删除 ==')
{
  const bin = makeFakeBin(SAMPLE, { delExit: 0 })
  const mgr = new EmulatorManager({ platform: 'harmony', tools: { bin } })
  const r = await mgr.remove('Phone A')
  check('删除已停止的', r.ok, r.error)

  const missing = await mgr.remove('Ghost')
  check('删不存在的报错', !missing.ok && /没有这个模拟器/.test(missing.error))
}

console.log('\n== 平台适配器 ==')
{
  check('三个平台都注册', !!(PLATFORMS.harmony && PLATFORMS.android && PLATFORMS.ios))
  const mgr = createEmulatorManager({ platform: 'android', tools: { bin: join(root, 'nope') } })
  check('android 走自己的适配器', mgr.platform === 'android' && mgr.label === 'Android')
  const ios = createEmulatorManager({ platform: 'ios', tools: {} })
  check('ios 走自己的适配器', ios.label === 'iOS')
}

console.log('\n== 非 JSON 输出 ==')
{
  const file = join(root, 'garbage.sh')
  writeFileSync(file, '#!/bin/sh\necho "not json at all"\n')
  chmodSync(file, 0o755)
  const mgr = new EmulatorManager({ platform: 'harmony', tools: { bin: file } })
  const r = mgr.list()
  check('解析失败时报错而不是抛异常', r.ok === false && /不是合法 JSON/.test(r.error), r.error)
}

rmSync(root, { recursive: true, force: true })

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
