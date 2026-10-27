/**
 * 文件锁与信号量单测。
 *
 * 这套东西决定「两个需求会不会同时进同一个槽位」，错了就会超并发跑崩机器，
 * 所以覆盖到僵尸锁、抢占、超时这些边界。
 *   node test/lock.js
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tryAcquireLock, acquireLock, withLock, SlotPool, clearPool } from '../src/infra/lock.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'lock-'))

console.log('\n== 互斥 ==')
{
  const f = join(root, 'a.lock')
  const a = tryAcquireLock(f)
  check('第一个拿到', a.ok)
  check('锁文件写入了 pid', JSON.parse(readFileSync(f, 'utf8')).pid === process.pid)

  const b = tryAcquireLock(f)
  check('第二个被拒', !b.ok)
  check('返回持有者信息', b.holder?.pid === process.pid, JSON.stringify(b.holder))

  a.release()
  const c = tryAcquireLock(f)
  check('释放后可再拿', c.ok)
  c.release()
}

console.log('\n== 僵尸锁抢占 ==')
{
  const f = join(root, 'stale.lock')
  // pid 999999 基本不可能存在；心跳时间也设得很旧
  writeFileSync(f, JSON.stringify({ pid: 999999, at: Date.now() - 60 * 60 * 1000 }))
  const r = tryAcquireLock(f)
  check('进程已死 → 可以抢占', r.ok)
  r?.release()

  // pid 活着但心跳过期
  writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() - 60 * 60 * 1000 }))
  const r2 = tryAcquireLock(f, { ttlMs: 1000 })
  check('心跳过期 → 可以抢占', r2.ok)
  r2?.release()

  // pid 活着且心跳新鲜 → 不能抢
  writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() }))
  const r3 = tryAcquireLock(f, { ttlMs: 60_000 })
  check('活着的持有者 → 不抢', !r3.ok)
  rmSync(f, { force: true })
}

console.log('\n== 损坏的锁文件 ==')
{
  const f = join(root, 'broken.lock')
  writeFileSync(f, 'not json at all')
  const r = tryAcquireLock(f)
  check('解析失败视为僵尸，可以抢', r.ok)
  r?.release()
}

console.log('\n== 等待式获取 ==')
{
  const f = join(root, 'wait.lock')
  const holder = tryAcquireLock(f)
  const started = Date.now()
  const got = await acquireLock(f, { waitMs: 300, pollMs: 50 })
  check('超时返回失败', !got.ok && got.timeout === true)
  check('确实等过（>=250ms）', Date.now() - started >= 250, String(Date.now() - started))

  holder.release()
  const got2 = await acquireLock(f, { waitMs: 1000, pollMs: 50 })
  check('释放后能拿到', got2.ok)
  got2.release()
}

console.log('\n== withLock ==')
{
  const f = join(root, 'with.lock')
  const r = await withLock(f, async () => 'done')
  check('返回函数结果', r.ok && r.value === 'done')
  const reacquired = tryAcquireLock(f)
  check('结束后已释放', reacquired.ok)
  reacquired.release()

  // 嵌套：内层拿不到
  const holder = tryAcquireLock(f)
  const inner = await withLock(f, async () => 'x', { waitMs: 100, pollMs: 20 })
  check('被占用时 withLock 超时', !inner.ok && inner.timeout === true)
  holder.release()
}

console.log('\n== 信号量 ==')
{
  const dir = join(root, 'slots')
  const pool = new SlotPool(dir, 3)
  check('初始全空', pool.stats().used === 0)

  const a = pool.tryAcquire('a')
  const b = pool.tryAcquire('b')
  const c = pool.tryAcquire('c')
  check('三个都拿到', !!a && !!b && !!c)
  check('满了', pool.stats().used === 3)
  check('第四个被拒', pool.tryAcquire('d') === null)

  a.release()
  check('释放一个后 used=2', pool.stats().used === 2)
  const e = pool.tryAcquire('e')
  check('能再拿一个', !!e)

  b.release()
  c.release()
  e.release()
  check('全部释放后 used=0', pool.stats().used === 0, JSON.stringify(pool.stats()))
}

console.log('\n== 信号量：超时与等待 ==')
{
  const dir = join(root, 'slots2')
  const pool = new SlotPool(dir, 1)
  const held = pool.tryAcquire()
  const started = Date.now()
  const got = await pool.acquire({ waitMs: 300, pollMs: 50 })
  check('超时返回 null', got === null)
  check('确实等过', Date.now() - started >= 250, String(Date.now() - started))

  held.release()
  const got2 = await pool.acquire({ waitMs: 1000, pollMs: 50 })
  check('释放后能拿到', !!got2)
  got2?.release()
}

console.log('\n== 信号量：僵尸占位清理 ==')
{
  const dir = join(root, 'slots3')
  mkdirSync(dir, { recursive: true })
  const pool = new SlotPool(dir, 2)
  // 造两条死进程的占位
  writeFileSync(join(dir, 'zombie-1'), JSON.stringify({ pid: 999999, at: Date.now() }))
  writeFileSync(join(dir, 'zombie-2'), JSON.stringify({ pid: 999998, at: Date.now() }))
  check('统计时自动清理僵尸', pool.stats().used === 0, JSON.stringify(pool.stats()))
  const s1 = pool.tryAcquire()
  const s2 = pool.tryAcquire()
  check('清理后名额可用', !!s1 && !!s2)
  s1?.release()
  s2?.release()
}

console.log('\n== 排队位置 ==')
{
  const dir = join(root, 'slots4')
  const pool = new SlotPool(dir, 2)
  const a = pool.tryAcquire()
  const b = pool.tryAcquire()
  check('满员时位置为 1', pool.position() === 1, String(pool.position()))
  a.release()
  check('释放后位置为 0', pool.position() === 0, String(pool.position()))
  b.release()
}

console.log('\n== 运维清理 ==')
{
  const dir = join(root, 'slots5')
  const pool = new SlotPool(dir, 5)
  pool.tryAcquire()
  pool.tryAcquire()
  clearPool(dir)
  check('clearPool 清空所有占位', pool.stats().used === 0)
}

rmSync(root, { recursive: true, force: true })

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
