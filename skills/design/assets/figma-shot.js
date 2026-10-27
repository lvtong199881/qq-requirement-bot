#!/usr/bin/env node
/**
 * 用本机 Chrome 的无头模式把渲染好的 HTML 截成 PNG。
 * 完全不消耗 Figma MCP 额度，所以设计说明里展示用的图优先走这里，
 * 不要为了几张图去调 get_screenshot。
 *
 * 用法：
 *   node assets/figma-shot.js <html 目录> <png 输出目录> [--scale=2]
 *   <html 目录> 是 figma-render.js 的产物结构：<html目录>/<页面标识>/<状态>.html
 *   输出到 <png 输出目录>/<页面标识>/<状态>.png
 *
 * 依赖：只需要本机装了 Chrome / Chromium / Edge 之一，不需要 playwright。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function fail(msg) {
  console.error('截图失败：' + msg);
  process.exit(1);
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  fail('找不到 Chrome / Chromium / Edge。装一个，或用 CHROME_PATH 环境变量指定可执行文件路径。');
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.html') && !e.name.startsWith('_')) out.push(full);
  }
  return out;
}

// 从 HTML 里读回画布尺寸，保证截图尺寸和 frame 完全一致
function readFrameSize(html) {
  const w = /#__frame\{[^}]*width:(\d+)px/.exec(html);
  const h = /#__frame\{[^}]*height:(\d+)px/.exec(html);
  if (!w || !h) fail('HTML 里找不到 #__frame 的宽高，确认是 figma-render.js 的产物');
  return { width: Number(w[1]), height: Number(h[1]) };
}

function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const scaleArg = (process.argv.find((a) => a.startsWith('--scale=')) || '').split('=')[1];
  const scale = scaleArg ? Number(scaleArg) : 2;

  if (argv.length < 2) {
    console.error('用法：node figma-shot.js <html 目录> <png 输出目录> [--scale=2]');
    process.exit(1);
  }
  const htmlDir = path.resolve(argv[0]);
  const pngDir = path.resolve(argv[1]);
  if (!fs.existsSync(htmlDir)) fail('目录不存在：' + htmlDir);
  if (!(scale > 0)) fail('--scale 必须是正数');

  const chrome = findChrome();
  const files = walk(htmlDir, []);
  if (!files.length) fail('没找到 HTML：' + htmlDir);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-shot-'));
  const done = [];

  for (const file of files) {
    const rel = path.relative(htmlDir, file).replace(/\.html$/, '.png');
    const out = path.join(pngDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const { width, height } = readFrameSize(fs.readFileSync(file, 'utf8'));
    const userDataDir = path.join(tmpRoot, 'profile-' + Math.random().toString(36).slice(2, 10));

    try {
      execFileSync(chrome, [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--default-background-color=00000000',
        '--force-device-scale-factor=' + scale,
        `--window-size=${width},${height}`,
        `--user-data-dir=${userDataDir}`,
        '--virtual-time-budget=3000',
        '--screenshot=' + out,
        'file://' + file,
      ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
    } catch (e) {
      const detail = e.stderr ? String(e.stderr).slice(-400) : e.message;
      fail(`Chrome 截图失败（${path.relative(htmlDir, file)}）：${detail}`);
    }

    if (!fs.existsSync(out) || fs.statSync(out).size < 100) {
      fail(`截图没产出有效文件：${out}`);
    }
    done.push(`${path.relative(pngDir, out)}（${width}×${height} @${scale}x）`);
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`已截图 ${done.length} 张，未消耗任何 Figma 额度：`);
  for (const d of done) console.log('  ' + d);
  console.log('');
  console.log('设计说明里直接用 Markdown 图片语法引用这些 PNG。');
  console.log('需要进 Figma 画布时走 capture 通道（同样不计额度），见 figma.md。');
}

main();
