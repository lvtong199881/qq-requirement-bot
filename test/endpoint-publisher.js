/**
 * 发现通道发布器测试。
 *
 * 不真连 Gitee：用一个本地 bare 仓库当远端，rawUrl 拼成指向它的
 * fake 形态测不了（URL 解析要 .../raw/<branch>/<path>），所以换一种
 * 打法——临时目录建 bare 远端 + 本地工作副本，rawUrl 用 file:// 协议
 * 指向 bare 仓库。git 支持 file://，publishEndpoint 的 clone/push
 * 全流程都能真跑，只是不出网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishEndpoint } from '../src/endpoint-publisher.js'

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`)
  return r.stdout
}

/** 搭一个本地 bare 远端，返回 file:// rawUrl（照 Gitee 的路径形态拼） */
function makeRemote(work) {
  const bare = join(work, 'remote.git')
  git(work, 'init', '--bare', bare)
  // HEAD 默认指 master；我们推的是 main。不指过去的话后续 clone
  // 会落在错误的空分支上（endpoint.json 永远读不到）。
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  // 先推一个含初始提交的 main 分支，raw 分支才有东西可 clone。
  // commit 必须带 -c user（CI/新机器没有全局身份会挂在 commit 上）。
  const seed = join(work, 'seed')
  git(work, 'clone', bare, seed)
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init')
  // clone 自空仓库时本地已落在 main（HEAD 已指 main），checkout 会
  // 撞「分支已存在」，所以改成确保式：在 main 上就跳过。
  const branchOut = spawnSync('git', ['branch', '--show-current'], { cwd: seed, encoding: 'utf8' })
  if ((branchOut.stdout ?? '').trim() !== 'main') git(seed, 'checkout', '-b', 'main')
  git(seed, 'push', 'origin', 'main')
  // file:// 指到 bare 仓库（正斜杠，git 的 file 协议不认反斜杠），
  // rawUrl 路径形态与 Gitee 一致
  const rawUrl = `file://${bare.split('\\').join('/')}/raw/main/endpoint.json`
  return { bare, rawUrl, seed }
}

function readEndpoint(bare) {
  // bare 仓库里读文件：先 clone 一份再读（测试专用，别嫌绕）。
  // Windows 下 clone 到 '.' 时 git 会拒绝（目标目录已存在但含隐藏项的
  // 情况不定），统一 clone 到临时目录的子目录里。
  const peek = mkdtempSync(join(tmpdir(), 'peek-'))
  const dst = join(peek, 'r')
  try {
    const r = spawnSync('git', ['clone', '--quiet', bare, dst], { cwd: peek, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`peek clone 失败：${r.stderr}`)
    return JSON.parse(readFileSync(join(dst, 'endpoint.json'), 'utf8'))
  } finally {
    rmSync(peek, { recursive: true, force: true })
  }
}

test('', async () => {
  const work = mkdtempSync(join(tmpdir(), 'epub-'))
  try {
    const { bare, rawUrl } = makeRemote(work)
    const logs = []
    const ok = await publishEndpoint({
      rawUrl,
      instanceId: 'inst_abc',
      urls: ['https://new.example.com', 'https://old.example.com'],
      log: (m) => logs.push(m),
    })
    assert.equal(ok, true)
    const payload = readEndpoint(bare)
    assert.equal(payload.instanceId, 'inst_abc')
    assert.deepEqual(payload.urls, ['https://new.example.com', 'https://old.example.com'])
    assert.ok(payload.updatedAt)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('', async () => {
  const work = mkdtempSync(join(tmpdir(), 'epub-'))
  try {
    const { bare, rawUrl } = makeRemote(work)
    await publishEndpoint({
      rawUrl,
      instanceId: 'inst_x',
      urls: ['https://a', 'https://b', 'https://c', 'https://d', 'https://e'],
      log: () => {},
    })
    assert.equal(readEndpoint(bare).urls.length, 3)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('', async () => {
  const work = mkdtempSync(join(tmpdir(), 'epub-'))
  try {
    const { rawUrl } = makeRemote(work)
    const logs = []
    const args = { rawUrl, instanceId: 'inst_x', urls: ['https://same'], log: (m) => logs.push(m) }
    assert.equal(await publishEndpoint(args), true)
    assert.equal(await publishEndpoint(args), true)
    assert.ok(logs.some((m) => m.includes('无需发布')))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('', async () => {
  const logs = []
  const ok = await publishEndpoint({
    rawUrl: 'https://gitee.com/u/repo',
    instanceId: 'inst_x',
    urls: ['https://a'],
    log: (m) => logs.push(m),
  })
  assert.equal(ok, false)
  assert.ok(logs.some((m) => m.includes('rawUrl')))
})

test('', async () => {
  const logs = []
  const ok = await publishEndpoint({ rawUrl: '', instanceId: 'x', urls: [], log: (m) => logs.push(m) })
  assert.equal(ok, false)
  assert.ok(logs.some((m) => m.includes('没配')))
})
