#!/usr/bin/env node
/**
 * 把 design-spec.json 渲染成自包含 HTML（供两件事用）：
 *   1. 本地无头浏览器截 PNG（不消耗 Figma 额度）
 *   2. generate_figma_design 捕获进 Figma 画布（该工具豁免额度）
 *
 * 用法：
 *   node assets/figma-render.js <design-spec.json> <输出目录>
 *   会为每个「页面 × 状态」写一个 <输出目录>/<页面标识>/<状态>.html
 *
 * 为什么需要它：design-spec.json 是唯一设计源。HTML 和 use_figma 代码都是它的
 * 派生物，绝不能手写第二份——手写就会和 spec 漂移，评审时对不上号。
 *
 * 与 figma-compile.js 的分工：
 *   figma-compile.js → 结构精确（真实 text / auto layout / annotation），但计额度
 *   figma-render.js  → 像素还原（浏览器真实排版），截 PNG 免费；配上 capture 通道
 *                      也能免费进 Figma，但图层是「捕获的 DOM」而非干净结构
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TYPES = new Set(['frame', 'text', 'rect', 'instance', 'image']);

function fail(msg) {
  console.error('渲染失败：' + msg);
  process.exit(1);
}

function normalizeSpecs(raw) {
  if (Array.isArray(raw)) {
    if (!raw.length) fail('spec 数组为空');
    return raw;
  }
  if (raw && typeof raw === 'object') return [raw];
  fail('design-spec.json 必须是对象或对象数组');
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Figma 字体族 -> 浏览器可用的字体栈。Figma 账号里只有 Noto Sans SC 等少数中文字体，
// 本机渲染时用系统字体兜底，保证 PNG 上中文正常显示。
const FONT_FALLBACK = {
  'Noto Sans SC': "'Noto Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif",
  'Noto Sans TC': "'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif",
  'Noto Sans JP': "'Noto Sans JP','Hiragino Sans',sans-serif",
  'Noto Sans KR': "'Noto Sans KR','Apple SD Gothic Neo',sans-serif",
  'Noto Serif SC': "'Noto Serif SC','Songti SC',serif",
  'Inter': "'Inter','Helvetica Neue',Arial,sans-serif",
};

const FONT_WEIGHT = {
  'Thin': 100, 'Extra Light': 200, 'Light': 300, 'Regular': 400, 'Medium': 500,
  'Semi Bold': 600, 'SemiBold': 600, 'Bold': 700, 'Extra Bold': 800,
  'ExtraBold': 800, 'Black': 900,
};

function fontCss(font) {
  if (!font || !font.family) return '';
  const stack = FONT_FALLBACK[font.family]
    || `'${font.family}','PingFang SC','Microsoft YaHei',sans-serif`;
  const parts = [`font-family:${stack}`];
  if (font.size) parts.push(`font-size:${font.size}px`);
  const w = FONT_WEIGHT[font.style];
  if (w) parts.push(`font-weight:${w}`);
  if (font.style && /Italic/i.test(font.style)) parts.push('font-style:italic');
  if (font.lineHeight) parts.push(`line-height:${font.lineHeight}px`);
  if (font.letterSpacing !== undefined) parts.push(`letter-spacing:${font.letterSpacing}px`);
  if (font.align) {
    const a = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[font.align];
    if (a) { parts.push(`text-align:${a}`); }
  }
  return parts.join(';');
}

function styleOf(s, parentHasLayout) {
  const css = ['box-sizing:border-box'];
  // text 的 fill 是文字颜色，其它节点是填充色——两者在 Figma 里都叫 fills，在 CSS 里不一样
  if (s.fill) css.push(s.type === 'text' ? `color:${s.fill}` : `background:${s.fill}`);
  if (s.opacity !== undefined && s.opacity < 1) css.push(`opacity:${s.opacity}`);
  if (s.radius !== undefined) css.push(`border-radius:${s.radius}px`);
  if (s.stroke) {
    css.push(`border:${s.strokeWeight || 1}px ${s.dashed ? 'dashed' : 'solid'} ${s.stroke}`);
  }
  if (s.width) css.push(`width:${s.width}px`);
  if (s.height) css.push(`height:${s.height}px`);

  if (parentHasLayout) {
    // 父节点是 auto layout：位置由 flex 排版决定，不写绝对坐标
    if (s.layout && (s.layout.hugWidth || s.layout.hugHeight)) css.push('flex:none');
  } else {
    css.push('position:absolute');
    css.push(`left:${s.x || 0}px`);
    // 没写 y 时由渲染器按文档顺序堆叠（和 figma-compile.js 的 placeChild 行为一致）
    css.push(`top:${s.y !== undefined ? s.y : '__AUTO_Y__'}px`);
  }
  return css.join(';');
}

// 与 figma-compile.js 的 placeChild 保持同一套规则：非 auto layout 的父节点下，
// 没写 y 的子节点按文档顺序垂直堆叠。两边的排版结果必须一致，否则 PNG 和 Figma 稿对不上。
function renderNodes(nodes, parentLayoutMode, indent) {
  const pad = '  '.repeat(indent);
  const out = [];
  let autoY = 0;
  for (const s of nodes) {
    if (!s || typeof s !== 'object') fail('节点必须是对象');
    if (!TYPES.has(s.type)) fail(`type「${s.type}」未登记`);
    const hasLayout = !!(s.layout && s.layout.mode);
    const css = styleOf(s, parentLayoutMode);

    let style = css;
    if (s.y === undefined) {
      style = style.replace('__AUTO_Y__', String(autoY));
      // 叠放的游标：节点高度 + gapAfter
      autoY += (s.height || (s.type === 'text' ? (s.font && s.font.size ? s.font.size * 1.4 : 16) : 0))
        + (s.gapAfter || 0);
    } else {
      style = style.replace('__AUTO_Y__', String(s.y));
    }

    const nameAttr = s.name ? ` data-name="${esc(s.name)}"` : '';

    if (s.type === 'text') {
      const t = fontCss(s.font);
      const txtCss = [
        style,
        'white-space:pre-wrap',
        'word-break:break-word',
        s.width ? '' : 'width:max-content',
      ].filter(Boolean).join(';');
      out.push(`${pad}<div${nameAttr} style="${txtCss};${t}">${esc(s.text)}</div>`);
      continue;
    }

    if (s.type === 'instance') {
      const ph = [
        style,
        'display:flex', 'align-items:center', 'justify-content:center',
        'border:1px dashed #FF3B30', 'color:#FF3B30',
        'font-size:12px', "font-family:'PingFang SC',sans-serif",
        'background:rgba(255,59,48,.06)',
      ].join(';');
      out.push(`${pad}<div${nameAttr} style="${ph}">⚠️ 待替换为组件：${esc(s.component || '未指定')}</div>`);
      continue;
    }

    if (s.type === 'image') {
      const ph = [
        style,
        'display:flex', 'align-items:center', 'justify-content:center',
        'border:1px dashed #FF3B30', 'color:#FF3B30',
        'font-size:12px', "font-family:'PingFang SC',sans-serif",
        'background:rgba(0,0,0,.06)',
      ].join(';');
      out.push(`${pad}<div${nameAttr} style="${ph}">⚠️ 待替换为图片：${esc(s.name || 'image')}</div>`);
      continue;
    }

    // frame / rect
    let box = style;
    if (hasLayout) {
      const L = s.layout;
      const flex = ['display:flex', `flex-direction:${L.mode === 'HORIZONTAL' ? 'row' : 'column'}`];
      const p = L.padding || [];
      if (p.length === 2) flex.push(`padding:${p[0]}px ${p[1]}px`);
      else if (p.length === 4) flex.push(`padding:${p[0]}px ${p[1]}px ${p[2]}px ${p[3]}px`);
      if (L.spacing !== undefined) flex.push(`gap:${L.spacing}px`);
      if (L.align) {
        const al = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' }[L.align];
        if (al) flex.push(`align-items:${al}`);
      }
      if (L.primaryAlign) {
        const al = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' }[L.primaryAlign];
        if (al) flex.push(`justify-content:${al}`);
      }
      if (L.hugWidth && L.mode === 'HORIZONTAL') flex.push('width:max-content');
      if (L.hugHeight && L.mode === 'VERTICAL') flex.push('height:max-content');
      box = box + ';' + flex.join(';');
    }
    if (s.children && s.children.length) {
      const inner = renderNodes(s.children, hasLayout, indent + 1);
      out.push(`${pad}<div${nameAttr} style="${box}">\n${inner}\n${pad}</div>`);
    } else {
      out.push(`${pad}<div${nameAttr} style="${box}"></div>`);
    }
  }
  return out.join('\n');
}

function renderPage(spec) {
  const f = spec.frame || {};
  const w = f.width || 375;
  const h = f.height || 812;
  const bg = f.background || '#FFFFFF';
  const body = renderNodes(spec.nodes || [], false, 2);
  const anns = (spec.annotations || [])
    .map((a) => `      <li>${esc(a.node)}：${esc(a.text)}</li>`)
    .join('\n');
  const annBlock = anns
    ? `\n    <!-- 改动点定位（不参与画布，仅便于人工核对） -->\n    <ul class="__ann" style="display:none">\n${anns}\n    </ul>`
    : '';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=${w}, initial-scale=1">
<title>${esc(spec.page)}/${esc(spec.state)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#fff}
#__frame{position:relative;width:${w}px;height:${h}px;background:${bg};overflow:hidden}
.__ann{list-style:none}
</style></head>
<body>
  <div id="__frame" data-page="${esc(spec.page)}" data-state="${esc(spec.state)}">
${body}
  </div>${annBlock}
</body></html>
`;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('用法：node figma-render.js <design-spec.json> <输出目录>');
    process.exit(1);
  }
  const input = path.resolve(argv[0]);
  const outDir = path.resolve(argv[1]);
  if (!fs.existsSync(input)) fail('文件不存在：' + input);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (e) {
    fail('JSON 解析失败：' + e.message);
  }
  const specs = normalizeSpecs(raw);

  const written = [];
  const seen = new Set();
  for (const spec of specs) {
    if (!spec.page || !spec.state) fail('每个 spec 必须有 page 和 state');
    const key = spec.page + '/' + spec.state;
    if (seen.has(key)) fail(`「${key}」重复`);
    seen.add(key);
    if (!spec.frame || !(spec.frame.width > 0) || !(spec.frame.height > 0)) {
      fail(`「${key}」的 frame.width / frame.height 必须是正数`);
    }
    const dir = path.join(outDir, spec.page);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, spec.state + '.html');
    fs.writeFileSync(file, renderPage(spec), 'utf8');
    written.push(file);
  }

  console.log('已渲染 ' + written.length + ' 个页面：');
  for (const f of written) console.log('  ' + f);
  console.log('');
  console.log('下一步：本地截 PNG（不耗额度）');
  console.log('  node assets/figma-shot.js <html目录> <png输出目录>');
}

main();
