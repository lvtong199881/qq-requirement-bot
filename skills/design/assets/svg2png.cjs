#!/usr/bin/env node
// svg2png.cjs —— 把 svggen.cjs 产出的 SVG 栅格化成 PNG（发群、进设计说明用）。
//
// 用法：node svg2png.cjs <svg 目录或单个 .svg> <png 输出目录> [--scale=3]
//   --scale 对应 spec 里的 canvas.deviceScale（1080px 宽的图 = 360dp × 3）。
//   --doctor 自检：报浏览器与栅格化后端是否可用。
//
// 两条渲染后端，自动选择：
//   1. Chrome headless（候选路径 Windows/macOS/Linux 全配齐 + CHROME_PATH 兜底）。
//      快、字体最接近真机；但在受限沙箱里（禁命名管道）mojo IPC 起不来，会挂到
//      超时——probe 实测 4 种旗标组合（--single-process/--in-process-gpu 全试过）
//      都救不了，这是架构级限制不是配置问题。
//   2. @resvg/resvg-js（预编译原生库，`npm i --prefix <本目录> @resvg/resvg-js`
//      装一次即可，无编译步骤）。Chrome 出不了图时自动用它，别再现场发明轮子——
//      上一轮设计 agent 就是为这个自己现装 node-canvas 手写脚本，白扔了十几分钟。
//
// 不联网（resvg 字体读系统目录）、不耗任何额度；Chrome 失败重试一次（换 --headless
// 老旗标，兼容旧版浏览器），仍不行才降级 resvg。

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

// SVG 根元素的 width/height 属性决定窗口大小——svggen.cjs 保证这两个属性存在
function svgSize(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 2000)
  const w = /<svg[^>]*\swidth="([\d.]+)"/.exec(head)
  const h = /<svg[^>]*\sheight="([\d.]+)"/.exec(head)
  if (!w || !h) fail(`${path.basename(file)}：读不到根元素 width/height（确认是 svggen.cjs 的产物）`)
  return { w: Math.round(Number(w[1])), h: Math.round(Number(h[1])) }
}

// 后端 1：Chrome 截图。返回 null 表示这个环境用不了（上层降级 resvg）。
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
    if (res.status === 0 && fs.existsSync(pngFile)) return null
    // 非 0 退出且还有老旗标没试 → 换旗标重来；否则把错误带出去给上层判断
    if (mode === 'old')
      return `exit ${res.status}：${String(res.stderr || res.stdout || '').slice(0, 400)}`
  }
}

// 后端 2：resvg 渲染。装法见文件头注释。
function loadResvg() {
  try {
    return require('@resvg/resvg-js')
  } catch {
    return null
  }
}

// resvg 出于安全默认不读外部文件引用（底图截图会渲染成黑块）——
// 把相对路径的 png/jpg 内联成 data URI 再喂给它
function inlineImages(svg, svgFile) {
  return svg.replace(/href="([^"]+\.(?:png|jpe?g))"/g, (m, ref) => {
    if (/^data:/.test(ref)) return m
    const abs = path.resolve(path.dirname(svgFile), decodeURIComponent(ref))
    if (!fs.existsSync(abs)) return m
    const mime = /\.jpe?g$/i.test(ref) ? 'image/jpeg' : 'image/png'
    return `href="data:${mime};base64,${fs.readFileSync(abs).toString('base64')}"`
  })
}

function renderWithResvg(ResvgClass, svgFile, pngFile, scale) {
  const { w } = svgSize(svgFile)
  const svg = inlineImages(fs.readFileSync(svgFile, 'utf8'), svgFile)
  const r = new ResvgClass(svg, {
    fitTo: { mode: 'width', value: Math.round(w * scale) },
    background: 'rgba(0,0,0,0)',
    font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' },
  })
  fs.writeFileSync(pngFile, r.render().asPng())
}

function main() {
  const args = process.argv.slice(2)
  const resvgMod = loadResvg()
  if (args.includes('--doctor')) {
    const p = findChrome()
    console.log(p ? `浏览器：${p}` : '没找到 Chrome/Edge（不影响：可用 resvg 后端）')
    console.log(resvgMod ? 'resvg 后端：可用' : 'resvg 后端：未安装（npm i --prefix <本目录> @resvg/resvg-js）')
    process.exit(p || resvgMod ? 0 : 2)
  }
  const src = args[0]
  const outDir = args[1]
  const scale = Number((args.find((a) => a.startsWith('--scale=')) ?? '--scale=3').split('=')[1]) || 3
  if (!src || !outDir) {
    console.error('用法：node svg2png.cjs <svg 目录或单个 .svg> <png 输出目录> [--scale=3]')
    process.exit(2)
  }
  // 沙箱/CI 里 Chrome 必挂（挂一次白等 60s 超时），SVG2PNG_BACKEND=resvg 直接跳过后端 1
  const forceBackend = process.env.SVG2PNG_BACKEND
  const chrome = forceBackend === 'resvg' ? null : findChrome()
  if (!chrome && !resvgMod)
    fail('没有任何渲染后端：装 Chrome/Edge，或在 svg2png.cjs 所在目录跑 npm i --prefix . @resvg/resvg-js（沙箱里设 SVG2PNG_BACKEND=resvg 只走 resvg）')

  const svgFiles = fs.statSync(src).isDirectory()
    ? fs.readdirSync(src).filter((f) => f.endsWith('.svg')).map((f) => path.join(src, f))
    : [src]
  if (svgFiles.length === 0) fail(`${src} 里没有 .svg`)
  fs.mkdirSync(outDir, { recursive: true })

  const done = []
  const backends = new Set()
  let chromeBroken = false
  for (const f of svgFiles) {
    const png = path.join(outDir, path.basename(f).replace(/\.svg$/, '.png'))
    if (chrome && !chromeBroken) {
      const err = shoot(chrome, f, png, scale)
      if (err === null) {
        done.push(png)
        backends.add('chrome')
        continue
      }
      // 第一张就挂基本是环境问题（沙箱禁 mojo），后续别再各试一遍白等 120s
      chromeBroken = true
      if (!resvgMod)
        fail(`Chrome 截图失败：${path.basename(f)}（${err}）\n且 resvg 后端未安装——在 svg2png.cjs 所在目录跑：npm i --prefix . @resvg/resvg-js`)
      console.error(`svg2png: Chrome 出不了图（${err.split('\n')[0]}），降级 resvg`)
    }
    renderWithResvg(resvgMod.Resvg, f, png, scale)
    done.push(png)
    backends.add('resvg')
  }
  console.log(`已出图 ${done.length} 张（scale=${scale}，后端 ${[...backends].join('+')}）：`)
  for (const p of done) console.log('  ' + p)
}

main()
