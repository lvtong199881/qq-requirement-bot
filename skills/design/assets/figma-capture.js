#!/usr/bin/env node
/**
 * 用本机 Chrome 把一页 HTML 提交给 Figma 的 capture 通道，变成画布上的真实图层。
 *
 * 这条通道对应的 MCP 工具是 generate_figma_design，它是**官方豁免限流**的，
 * 所以出稿不消耗每月 20 次的 MCP 额度。代价是图层来自「捕获的 DOM」，
 * 不是 use_figma 那种干净的原生结构（文字会变成带样式的 text 节点，
 * 嵌套可能比 spec 更碎）。要精确结构就用 use_figma，要免费就用这里。
 *
 * 分工：本脚本**只管浏览器这一半**，不碰 Figma 鉴权。
 * captureId 和 endpoint 由调用方（模型）通过 MCP 工具拿到再传进来：
 *
 *   1) generate_figma_design { fileKey }              → 返回 captureId
 *   2) node figma-capture.js <html文件或目录> <captureId>  ← 本脚本
 *   3) generate_figma_design { fileKey, captureId }   → 轮询到 completed，拿 node-id
 *
 * 用法：
 *   node assets/figma-capture.js <html 文件或目录> <captureId[,captureId2,...]> [--delay=1500]
 *
 * 目录模式：会为目录下每个 <页面标识>/<状态>.html 单独提交一次，
 * 每个页面都要一个独立的 captureId，脚本会按顺序消费它们（逗号分隔传入）。
 *
 * 依赖：只用 Node 内置模块 + 本机 Chrome / Chromium / Edge。不需要 playwright。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function fail(msg) {
  console.error('捕获失败：' + msg);
  process.exit(1);
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  fail('找不到 Chrome / Chromium / Edge。装一个，或用 CHROME_PATH 指定路径。');
}

function walkHtml(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkHtml(full, out);
    else if (e.name.endsWith('.html') && !e.name.startsWith('_')) out.push(full);
  }
  return out;
}

// capture.js 必须真的在页面上跑起来，否则 Figma 端永远 pending。
// figma-render.js 是给截图用的，不带这个 script；捕获前必须注入。
const CAPTURE_SRC = 'https://mcp.figma.com/mcp/html-to-design/capture.js';

function ensureCaptureScript(html) {
  if (html.includes(CAPTURE_SRC)) return html;
  const tag = `<script src="${CAPTURE_SRC}" async></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + '\n' + tag);
  return tag + '\n' + html;
}

function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rel;
      try {
        rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      } catch (e) {
        res.writeHead(400); res.end('bad url'); return;
      }
      const file = path.join(root, rel);
      // 目录穿越保护
      if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 用 CDP 直驱 Chrome：--screenshot 那种一次性模式会在 capture.js 提交完成前就退出，
// 实测永远 pending。CDP 能一直等到网络请求真的发出为止。
async function captureViaCdp(chrome, url, { delayMs, timeoutMs }) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-capture-'));
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { proc.kill('SIGKILL'); } catch (e) {}
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };

  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!version) { cleanup(); fail('Chrome 的调试端口没起来，可能被安全策略拦了。'); }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) { cleanup(); fail('Chrome 没有可用页面。'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
  });

  let seq = 0;
  const pending = new Map();
  const submits = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/capture/')) {
      submits.push(m.params.response.status);
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await send('Page.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 812, deviceScaleFactor: 2, mobile: false,
    });
    await send('Page.navigate', { url });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (submits.length && submits.some((s) => s >= 200 && s < 300)) break;
    }
    // 提交后留一点时间让服务端收尾
    await new Promise((r) => setTimeout(r, Math.max(delayMs, 1200)));
  } finally {
    try { ws.close(); } catch (e) {}
    cleanup();
  }

  if (!submits.length) {
    fail('页面没有向 Figma 提交任何内容。检查：HTML 里是否注入了 capture.js（本脚本会自动注入）、网络是否可达 mcp.figma.com。');
  }
  if (!submits.some((s) => s >= 200 && s < 300)) {
    fail('提交返回了非 2xx：' + submits.join(',') + '。captureId 可能已被用过（每个只能消费一次）。');
  }
  return submits.join(',');
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : dflt;
  };
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error('用法：node figma-capture.js <html 文件或目录> <captureId[,captureId2,...]> [--delay=1500] [--timeout=20000]');
    process.exit(1);
  }

  const target = path.resolve(positional[0]);
  const ids = positional[1].split(',').map((s) => s.trim()).filter(Boolean);
  const delayMs = Number(opt('delay', '1500'));
  const timeoutMs = Number(opt('timeout', '20000'));
  if (!fs.existsSync(target)) fail('路径不存在：' + target);

  const files = fs.statSync(target).isDirectory()
    ? walkHtml(target, []).sort()
    : [target];
  if (!files.length) fail('没找到 HTML。');
  if (files.length !== ids.length) {
    fail(`有 ${files.length} 个页面但给了 ${ids.length} 个 captureId。每个页面要一个独立 ID，用逗号分隔。`);
  }

  const root = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const chrome = findChrome();
  const results = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const id = ids[i];
    // 注入 capture.js 到一份临时副本，不改动原 HTML（原文件还要给截图用）
    const original = fs.readFileSync(file, 'utf8');
    const prepared = ensureCaptureScript(original);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-cap-html-'));
    const tmpFile = path.join(tmpDir, path.basename(file));
    fs.writeFileSync(tmpFile, prepared, 'utf8');

    // 临时副本放在独立目录里起服务，避免往项目目录写文件
    const sub = await startServer(tmpDir);
    const endpoint = `https://mcp.figma.com/mcp/capture/${id}/submit?bindVariables=true`;
    const url = `http://127.0.0.1:${sub.port}/${encodeURIComponent(path.basename(file))}`
      + `#figmacapture=${id}`
      + `&figmaendpoint=${encodeURIComponent(endpoint)}`
      + `&figmadelay=${delayMs}`;

    process.stderr.write(`→ ${path.relative(root, file)}（captureId ${id.slice(0, 8)}…）`);
    try {
      const status = await captureViaCdp(chrome, url, { delayMs, timeoutMs });
      results.push({ file: path.relative(root, file), id, status });
      process.stderr.write(` 提交 ${status}\n`);
    } finally {
      sub.server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify(results, null, 2));
  console.log('');
  console.log('现在用 generate_figma_design { fileKey, captureId } 逐个轮询到 completed，拿 node-id。');
}

main();
