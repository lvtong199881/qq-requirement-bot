#!/usr/bin/env node
/**
 * Figma OAuth token 预检与授权。
 *
 * 阶段 2 一开始就先跑 `check`：token 没有或即将过期时，立刻 `authorize`，
 * 不要等到真正要上传时才发现连不上、让用户卡在流程中间。
 *
 * 用法：
 *   node assets/figma-auth.js check                    # 只检查，不写任何文件
 *   node assets/figma-auth.js check --json             # 机器可读
 *   node assets/figma-auth.js authorize [--timeout=180] # 发起授权（会打开浏览器）
 *
 * 退出码：
 *   0  token 可用（check 时为「剩余天数 > 预警线」）
 *   2  token 缺失或即将过期（需要 authorize）
 *   3  authorize 超时，用户没在浏览器里完成
 *   1  其它错误（bridge 没装、读不到 client_info 等）
 *
 * token 存放规则来自 mcp-remote：目录是 ~/.mcp-auth/mcp-remote-v1/，
 * 文件名是 <md5(serverUrl)>_tokens.json，同目录还有 _client_info.json。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SERVER_URL = process.env.FIGMA_MCP_URL || 'https://mcp.figma.com/mcp';
// Figma 的动态客户端注册按 client_name 白名单放行，实测只有 "Claude Code" 能过。
// 这个名字必须和 cordis.patch.yml 里桥接进程用的完全一致，否则重新授权会 403。
const CLIENT_NAME = 'Claude Code';
// 剩余有效期低于这个天数就提前续，避免设计到一半过期。
const WARN_DAYS = 7;

const AUTH_DIR = path.join(os.homedir(), '.mcp-auth', 'mcp-remote-v1');
const SERVER_HASH = crypto.createHash('md5').update(SERVER_URL).digest('hex');
const TOKENS_PATH = path.join(AUTH_DIR, SERVER_HASH + '_tokens.json');
const CLIENT_PATH = path.join(AUTH_DIR, SERVER_HASH + '_client_info.json');

function fail(msg, code) {
  console.error('Figma 授权检查失败：' + msg);
  process.exit(code || 1);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 汇总当前 token 状态，不写任何文件。 */
function inspect() {
  const tk = readJson(TOKENS_PATH);
  const ci = readJson(CLIENT_PATH);
  const out = {
    serverUrl: SERVER_URL,
    tokensPath: TOKENS_PATH,
    hasClientInfo: !!ci,
    clientName: ci ? ci.client_name : null,
    hasToken: false,
    expiresAt: null,
    daysLeft: null,
    expired: true,
    needsAuth: true,
    reason: '',
  };

  if (!tk || !tk.access_token) {
    out.reason = 'token 文件不存在或没有 access_token';
    return out;
  }
  out.hasToken = true;

  // expires_at 是毫秒时间戳；个别版本只给 expires_in，按签发时刻兜底。
  let expiresAtMs = null;
  if (typeof tk.expires_at === 'number') {
    expiresAtMs = tk.expires_at;
  } else if (typeof tk.expires_in === 'number') {
    const mtime = fs.statSync(TOKENS_PATH).mtimeMs;
    expiresAtMs = mtime + tk.expires_in * 1000;
  }
  if (!expiresAtMs) {
    out.reason = 'token 没有过期时间字段，无法判断有效期';
    return out;
  }

  const daysLeft = (expiresAtMs - Date.now()) / 86400000;
  out.expiresAt = new Date(expiresAtMs).toISOString();
  out.daysLeft = Math.round(daysLeft * 10) / 10;
  out.expired = daysLeft <= 0;

  if (out.expired) {
    out.reason = 'token 已过期';
  } else if (daysLeft < WARN_DAYS) {
    out.reason = 'token 剩余 ' + out.daysLeft + ' 天，低于预警线 ' + WARN_DAYS + ' 天';
  } else {
    out.needsAuth = false;
    out.reason = 'token 有效，剩余 ' + out.daysLeft + ' 天';
  }

  if (ci && ci.client_name !== CLIENT_NAME) {
    out.needsAuth = true;
    out.reason += '；client_name 是 "' + ci.client_name + '"，重新授权会 403';
  }
  return out;
}

/** 调 mcp-remote 走一次完整 OAuth。它自己开浏览器、自己监听回调、自己写 token 文件。 */
function authorize(timeoutSec) {
  const proxy = process.env.FIGMA_MCP_PROXY || findProxy();
  if (!proxy) {
    fail('找不到 mcp-remote。请先按 figma.md 第一节把桥接装到 ~/.dsh/mcp/figma/');
  }

  const before = readJson(TOKENS_PATH);
  const beforeToken = before ? before.access_token : null;

  const child = spawn(process.execPath, [
    proxy,
    SERVER_URL,
    '--static-oauth-client-metadata',
    JSON.stringify({ client_name: CLIENT_NAME, scope: 'mcp:connect' }),
  ], {
    // mcp-remote 靠 stdin 存活：stdin 一关它立刻退出，授权还没完成就断了。
    stdio: ['pipe', 'inherit', 'inherit'],
    detached: false,
  });

  console.error('[figma-auth] 已拉起桥接进程，请在打开的浏览器里登录 Figma 并同意授权…');

  let settled = false;
  const timer = setInterval(() => {
    const now = readJson(TOKENS_PATH);
    if (now && now.access_token && now.access_token !== beforeToken) {
      settled = true;
      clearInterval(timer);
      try { child.kill('SIGTERM'); } catch (_) {}
      const info = inspect();
      console.log('授权完成：' + info.reason);
      console.log('token 文件：' + TOKENS_PATH);
      process.exit(0);
    }
  }, 1000);

  const deadline = setTimeout(() => {
    if (settled) return;
    clearInterval(timer);
    try { child.kill('SIGTERM'); } catch (_) {}
    console.error('授权超时（' + timeoutSec + ' 秒）。请重新运行：node assets/figma-auth.js authorize');
    process.exit(3);
  }, timeoutSec * 1000);

  child.on('exit', (code) => {
    if (settled) return;
    clearInterval(timer);
    clearTimeout(deadline);
    // 桥接自己退出了（通常是被别的实例抢了授权协调、或用户关了浏览器）
    const after = readJson(TOKENS_PATH);
    if (after && after.access_token && after.access_token !== beforeToken) {
      console.log('授权完成：' + inspect().reason);
      process.exit(0);
    }
    console.error('桥接进程退出（code=' + code + '），未拿到新 token。');
    process.exit(3);
  });
}

function findProxy() {
  const candidates = [
    path.join(os.homedir(), '.dsh', 'mcp', 'figma', 'node_modules', 'mcp-remote', 'dist', 'proxy.js'),
    path.join(os.homedir(), '.dsh', 'mcp', 'figma', 'node_modules', 'mcp-remote', 'dist', 'proxy.cjs'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 拿 token 真的打一次 MCP 的 whoami。
 * 光看 expires_at 不够：实测遇到过文件里写着两小时后才到期、服务端却已经 401 的情况
 * （token 被别的授权流程顶掉、或被服务端作废）。whoami 不计额度，可以当健康探针用。
 */
async function verifyToken() {
  const tk = readJson(TOKENS_PATH);
  if (!tk || !tk.access_token) return { ok: false, status: 0, detail: '没有 token' };

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'whoami', arguments: {} },
  });

  let res;
  try {
    res = await fetch(SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + tk.access_token,
        'MCP-Protocol-Version': '2025-06-18',
      },
      body,
    });
  } catch (e) {
    return { ok: false, status: 0, detail: '网络错误：' + e.message };
  }

  const text = await res.text();
  if (res.status === 401) {
    return { ok: false, status: 401, detail: '服务端返回 401 Unauthorized（token 已作废，需重新授权）' };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, detail: '服务端返回 HTTP ' + res.status };
  }

  // 可能是 SSE 或纯 JSON
  let payload = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { payload = JSON.parse(line.slice(6)); } catch (_) {}
    }
  }
  if (!payload) {
    try { payload = JSON.parse(text); } catch (_) {}
  }
  if (!payload) return { ok: false, status: res.status, detail: '响应无法解析' };

  const result = payload.result || {};
  if (result.isError) {
    const msg = (result.content && result.content[0] && result.content[0].text) || '';
    return { ok: false, status: res.status, detail: '工具报错：' + msg.slice(0, 200) };
  }

  const raw = (result.content && result.content[0] && result.content[0].text) || '';
  let who = null;
  try { who = JSON.parse(raw).whoami; } catch (_) {}
  return { ok: true, status: res.status, whoami: who };
}

function describeWhoami(who) {
  if (!who) return '';
  const plan = (who.plans && who.plans[0]) || {};
  return [
    '账号：' + (who.handle || '?') + ' <' + (who.email || '?') + '>',
    '计划：' + (plan.tier || '?') + ' / 席位 ' + (plan.seat || '?') + ' / ' + (plan.name || '?'),
    'planKey：' + (plan.key || '?'),
  ].join('\n');
}

async function main() {
  const cmd = process.argv[2];
  const timeoutArg = process.argv.find((a) => a.startsWith('--timeout='));
  const timeoutSec = timeoutArg ? Number(timeoutArg.split('=')[1]) : 180;

  if (cmd === 'check') {
    const info = inspect();
    const json = process.argv.includes('--json');
    // --offline 只读本地文件，不联网（断网排查时用）
    const offline = process.argv.includes('--offline');

    if (!info.needsAuth && !offline) {
      const v = await verifyToken();
      info.serverOk = v.ok;
      if (!v.ok) {
        info.needsAuth = true;
        info.reason = v.detail;
      } else {
        info.whoami = v.whoami;
        info.reason = 'token 有效且服务端可用，剩余 ' + info.daysLeft + ' 天';
      }
    }

    if (json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log('服务：' + info.serverUrl);
      console.log('状态：' + info.reason);
      if (info.expiresAt) console.log('到期：' + info.expiresAt + '（剩余 ' + info.daysLeft + ' 天）');
      const desc = describeWhoami(info.whoami);
      if (desc) console.log(desc);
      if (info.needsAuth) console.log('下一步：node assets/figma-auth.js authorize');
    }
    process.exit(info.needsAuth ? 2 : 0);
  }

  if (cmd === 'authorize') {
    authorize(timeoutSec);
    return;
  }

  console.error('用法：node assets/figma-auth.js check [--json] | authorize [--timeout=180]');
  process.exit(1);
}

main();
