// svggen.cjs 渲染器测试：不改实现就能断言几何——靠 --json 导出的量盒，
// 不需要浏览器。fixture 用 skills/design/examples/welcome-dialog（金标准示例）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const gen = join(root, 'skills', 'design', 'assets', 'svggen.cjs')
const fixture = join(root, 'skills', 'design', 'examples', 'welcome-dialog', 'layouts.json')
const outDir = join(root, '.tmp-svggen-test')
const boxesPath = join(outDir, 'boxes.json')

// Windows 上 execFileSync('node') 会 ENOENT（子进程的 PATH 解析不可靠），
// 用当前进程自己的二进制最稳。
const render = (args) => execFileSync(process.execPath, [gen, ...args], { cwd: root })

// 各测试共用一次渲染产物；node:test 默认按文件顺序跑，但每个测试自己确保
// 产物在（第一个测试挂了后面的才有意义）。
const ensureRendered = () => {
  if (!existsSync(boxesPath)) render([fixture, outDir, `--json=${boxesPath}`])
}

test('渲染金标准示例：3 帧 SVG + boxes.json', () => {
  rmSync(outDir, { recursive: true, force: true })
  render([fixture, outDir, `--json=${boxesPath}`])
  for (const id of ['F01_empty_zh_light', 'F02_dialog_zh_light', 'F03_dialog_zh_dark']) {
    assert.ok(existsSync(join(outDir, `${id}.svg`)), `${id}.svg 应存在`)
  }
  assert.ok(existsSync(boxesPath))
})

test('量盒：按钮撑满 footer 内容盒（320 - 左右 padding 各 20 = 280）', () => {
  ensureRendered()
  const boxes = JSON.parse(readFileSync(boxesPath, 'utf8'))
  const btn = boxes.F02_dialog_zh_light.find((b) => b.name === 'button')
  assert.equal(btn.width, 280)
  assert.equal(btn.height, 48)
})

test('胶囊圆角钳到高度一半（rx=24，不是 999 也不是宽的一半）', () => {
  ensureRendered()
  const svg = readFileSync(join(outDir, 'F02_dialog_zh_light.svg'), 'utf8')
  assert.ok(svg.includes('rx="24"'), '按钮 rect 应该是 rx="24"')
})

test('CJK 长文案换行：feature desc 多行，行数记进量盒', () => {
  ensureRendered()
  const boxes = JSON.parse(readFileSync(boxesPath, 'utf8'))
  const desc = boxes.F02_dialog_zh_light.find((b) => b.name === 'feature.1.desc')
  assert.ok(desc.lines.length >= 2, `长文案应折行，实际 ${desc.lines.length} 行`)
})

test('文本落在父内容盒里（title x = dialog.x + body.padding.left）', () => {
  ensureRendered()
  const svg = readFileSync(join(outDir, 'F02_dialog_zh_light.svg'), 'utf8')
  // dialog x=20 + body padding-left 24 = 44
  assert.ok(svg.includes('<text x="44"'), 'title 的 x 应是 44（20+24）')
})

test('校验失败不出半成品：删掉 icon token 整体退出、一个文件都不留', () => {
  const spec = JSON.parse(readFileSync(fixture, 'utf8'))
  delete spec.designTokens.icons.items.mic
  mkdirSync(outDir, { recursive: true })
  const bad = join(outDir, 'bad-layouts.json')
  writeFileSync(bad, JSON.stringify(spec))
  const badOut = join(outDir, 'bad-out')
  let failed = false
  try {
    render([bad, badOut])
  } catch {
    failed = true
  }
  assert.ok(failed, '坏引用要整体失败')
  assert.ok(!existsSync(badOut), '校验没过连输出目录都不该建')
})
