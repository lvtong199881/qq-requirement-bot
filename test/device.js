/**
 * 设备发现与独占分配单测。
 *
 * 设备抢不到或抢重复，表现是「测试跑到别人的版本上」这种极难排查的问题，
 * 所以覆盖：多平台发现、配置优先、互斥、僵尸锁清理。
 *   node test/device.js
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listDevices, DevicePool, PLATFORMS } from '../src/infra/device.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'device-'))

console.log('\n== 平台适配器 ==')
{
  check('三个平台都注册了', !!(PLATFORMS.harmony && PLATFORMS.android && PLATFORMS.ios))
  check('鸿蒙有中文名', PLATFORMS.harmony.label === '鸿蒙')
  check('Android 有中文名', PLATFORMS.android.label === 'Android')
}

console.log('\n== 配置优先于自动发现 ==')
{
  const r = listDevices({ platform: 'harmony', devices: ['dev-a', 'dev-b'] })
  check('来源是 config', r.source === 'config')
  check('两台都在', r.devices.length === 2)
  check('平台标注正确', r.platform === 'harmony')

  // 对象形式带 name
  const r2 = listDevices({ platform: 'android', devices: [{ id: 'emulator-5554', name: 'Pixel 7' }] })
  check('对象形式解析 name', r2.devices[0].name === 'Pixel 7')
}

console.log('\n== 自动发现（本机可能没有设备） ==')
{
  const r = listDevices({ platform: 'harmony', tools: { hdc: 'definitely-not-a-command' } })
  check('命令不存在时不抛错', r.ok === true)
  check('返回空列表', Array.isArray(r.devices) && r.devices.length === 0)
  check('标记 empty', r.empty === true)
}

console.log('\n== 未知平台 ==')
{
  const r = listDevices({ platform: 'windows-phone' })
  check('报错而不是静默', r.ok === false, JSON.stringify(r))
  check('错误信息可读', /不认识的平台/.test(r.error), r.error)
}

console.log('\n== 设备池：互斥 ==')
{
  const lockDir = join(root, 'locks')
  const pool = new DevicePool({ lockDir, platform: 'harmony', devices: [{ id: 'dev-a' }, { id: 'dev-b' }] })

  const a = pool.tryAcquire({ reqId: 'req-1', stage: 'dev' })
  const b = pool.tryAcquire({ reqId: 'req-2', stage: 'dev' })
  check('两个需求各拿一台', a.ok && b.ok)
  check('拿到的是不同设备', a.deviceId !== b.deviceId, `${a.deviceId} vs ${b.deviceId}`)

  const c = pool.tryAcquire({ reqId: 'req-3', stage: 'test' })
  check('两台都占满时第三个拿不到', !c.ok)
  check('原因说清楚', c.reason === '所有设备都在忙', c.reason)

  a.release()
  const d = pool.tryAcquire({ reqId: 'req-3' })
  check('释放后能拿到', d.ok && d.deviceId === a.deviceId)
  b.release()
  d.release()
}

console.log('\n== 设备池：状态查询 ==')
{
  const lockDir = join(root, 'locks2')
  const pool = new DevicePool({ lockDir, platform: 'harmony', devices: [{ id: 'dev-a' }, { id: 'dev-b' }] })
  const a = pool.tryAcquire({ reqId: 'req-1', stage: 'dev' })

  const st = pool.status()
  check('列出所有设备', st.length === 2)
  check('占用状态正确', st.find((d) => d.id === a.deviceId).busy === true)
  check('记录占用者', st.find((d) => d.id === a.deviceId).holder === 'req-1')
  check('空闲的那台是 false', st.find((d) => d.id !== a.deviceId).busy === false)
  a.release()
}

console.log('\n== 设备池：僵尸锁清理 ==')
{
  const lockDir = join(root, 'locks3')
  mkdirSync(lockDir, { recursive: true })
  const pool = new DevicePool({ lockDir, platform: 'harmony', devices: [{ id: 'dev-a' }] })

  // 造一条死进程的锁
  writeFileSync(join(lockDir, 'dev-dev-a.lock'), JSON.stringify({ pid: 999999, deviceId: 'dev-a' }))
  const r = pool.tryAcquire({ reqId: 'req-new' })
  check('死进程的锁被清掉，可以拿到', r.ok, JSON.stringify(r))
  r?.release()
}

console.log('\n== 设备池：没有设备 ==')
{
  const pool = new DevicePool({ lockDir: join(root, 'locks4'), platform: 'harmony', devices: [] })
  const r = pool.tryAcquire()
  check('返回明确原因', !r.ok && r.reason === '没有可用设备', JSON.stringify(r))
  const waited = await pool.acquire({ waitMs: 100, pollMs: 50 })
  check('等待也立即返回 null（无设备不用等）', waited === null)
}

console.log('\n== 设备池：等待释放 ==')
{
  const pool = new DevicePool({ lockDir: join(root, 'locks5'), platform: 'harmony', devices: [{ id: 'dev-a' }] })
  const held = pool.tryAcquire({ reqId: 'r1' })
  setTimeout(() => held.release(), 300)
  const got = await pool.acquire({ waitMs: 3000, pollMs: 100, reqId: 'r2' })
  check('等到了别人释放的设备', !!got, '应该拿到')
  got?.release()
}

rmSync(root, { recursive: true, force: true })

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
