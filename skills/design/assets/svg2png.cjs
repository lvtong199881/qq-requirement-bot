#!/usr/bin/env node
// svg2png.js —— 把 spec2svg.js 产出的 SVG 栅格化成 PNG（发群、进设计说明用）。
//
// 用法：node svg2png.js <svg 目录或单个 .svg> <png 输出目录> [--scale=3]
//   --scale 对应 spec 里的 canvas.deviceScale（1080px 宽的图 = 360dp × 3）。
//
// Chrome 候选路径 Windows / macOS / Linux 全配齐 + CHROME_PATH 环境变量兜底。
// 上次设计阶段 agent 被迫自写 ps1 抓浏览器，根因就是旧脚本候选表里没有 Windows——
// 这份表以本机实测为准，改路径先跑 node svg2png.js --doctor。
//
// 不联网、不耗任何额度；失败重试一次（换 --headless 老旗标，兼容旧版浏览器）。

'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

function fail(msg) {
  console.error(`svg2png: ${msg}`)
  process.exit(1)
}

const CHROME_CANDIDATES = [
  // Windows（含 Edge——浏览器内核一致，本机没装 Chrome 时它是正常出路）
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
]

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p
  return null
}

// SVG 根元素的 width/height 属性决定窗口大小——spec2svg.js 保证这两个属性存在
function svgSize(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 2000)
  const w = /<svg[^>]*\swidth="([\d.]+)"/.exec(head)
  const h = /<svg[^>]*\sheight="([\d.]+)"/.exec(head)
  if (!w || !h) fail(`${path.basename(file)}：读不到根元素 width/height（确认是 spec2svg.js 的产物）`)
  return { w: Math.round(Number(w[1])), h: Math.round(Number(h[1])) }
}

function shoot(chrome, svgFile, pngFile, scale) {
  const { w, h } = svgSize(svgFile)
  const url = 'file:///' + path.resolve(svgFile).split(path.sep).join('/')
  for (const mode of ['new', 'old']) {
    const flags =
      mode === 'new'
        ? ['--headless=new', `--force-device-scale-factor=${scale}`]
        : ['--headless', `--force-device-scale-factor=${scale}`]
    const res = spawnSync(
      chrome,
      [
        ...flags,
        '--screenshot=' + pngFile,
        `--window-size=${w},${h}`,
        '--default-background-color=00000000',
        '--hide-scrollbars',
        '--no-first-run',
        '--disable-extensions',
        '--disable-gpu',
        url,
      ],
      { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (res.status === 0 && fs.existsSync(pngFile)) return
    // 非 0 退出且还有老旗标没试 → 换旗标重来；否则把错误带出去
    if (mode === 'old')
      fail(
        `截图失败：${path.basename(svgFile)}（exit ${res.status}）\n${String(res.stderr || res.stdout || '').slice(0, 400)}`,
      )
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--doctor')) {
    const p = findChrome()
    console.log(p ? `找到浏览器：${p}` : '没找到 Chrome/Edge，设 CHROME_PATH 指到浏览器可执行文件')
    process.exit(p ? 0 : 2)
  }
  const src = args[0]
  const outDir = args[1]
  const scale = Number((args.find((a) => a.startsWith('--scale=')) ?? '--scale=3').split('=')[1]) || 3
  if (!src || !outDir) {
    console.error('用法：node svg2png.js <svg 目录或单个 .svg> <png 输出目录> [--scale=3]')
    process.exit(2)
  }
  const chrome = findChrome()
  if (!chrome)
    fail('找不到 Chrome/Edge。装一个，或设 CHROME_PATH 环境变量指到浏览器可执行文件')

  const svgFiles = fs.statSync(src).isDirectory()
    ? fs.readdirSync(src).filter((f) => f.endsWith('.svg')).map((f) => path.join(src, f))
    : [src]
  if (svgFiles.length === 0) fail(`${src} 里没有 .svg`)
  fs.mkdirSync(outDir, { recursive: true })

  const done = []
  for (const f of svgFiles) {
    const png = path.join(outDir, path.basename(f).replace(/\.svg$/, '.png'))
    shoot(chrome, f, png, scale)
    done.push(png)
  }
  console.log(`已截图 ${done.length} 张（scale=${scale}）：`)
  for (const p of done) console.log('  ' + p)
}

main()
