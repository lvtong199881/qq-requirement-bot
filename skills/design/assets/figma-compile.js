#!/usr/bin/env node
/**
 * 把 design-spec.json 编译成可直接喂给 use_figma 的 JavaScript 代码。
 *
 * 用法：
 *   node assets/figma-compile.js <design-spec.json> [输出文件]
 *   不带输出文件时打印到 stdout。
 *
 * 为什么需要它：design-spec.json 是设计源（可 diff、可重放、可评审），
 * use_figma 只认 Plugin API 代码。每次让模型手写代码会有随机偏差，
 * 编译一遍能保证「同一份 spec 永远产出同一棵树」。
 *
 * 产物必须满足 figma-use 的硬约束（踩过的坑，见 figma.md 第四节）：
 *   - 用 return 输出，不 closePlugin、不包 async IIFE
 *   - 颜色 0–1，paint 只有 {r,g,b}，opacity 放 paint 层
 *   - fills 是只读数组，整体重新赋值而不是 push
 *   - 文本先 loadFontAsync 再写 characters
 *   - 有 auto layout 的父节点下不写绝对坐标
 *   - resize() 会把 sizing mode 复位为 FIXED，所以在配置 layoutSizing 之前调用
 *   - 顶层节点不放在 (0,0)
 *   - 必须 return 所有创建的节点 id
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TYPES = new Set(['frame', 'text', 'rect', 'instance', 'image']);

function fail(msg) {
  console.error('构建失败：' + msg);
  process.exit(1);
}

function normalizeSpecs(raw) {
  if (Array.isArray(raw)) {
    if (!raw.length) fail('spec 数组为空，至少要给一个页面状态');
    return raw;
  }
  if (raw && typeof raw === 'object') return [raw];
  fail('design-spec.json 必须是对象，或对象数组（多状态一次出稿）');
}

function validate(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('spec 必须是 JSON 对象');
  if (!spec.page || typeof spec.page !== 'string') fail('缺 page（页面标识，例如 task-list）');
  if (!spec.state || typeof spec.state !== 'string') fail('缺 state（状态名，例如 空态）');
  const f = spec.frame;
  if (!f || typeof f !== 'object') fail('缺 frame 对象');
  if (!(f.width > 0) || !(f.height > 0)) fail('frame.width / frame.height 必须是正数');
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) fail('nodes 为空，至少要有节点');

  const seen = new Set();
  const walk = (nodes, parentHasLayout, trail) => {
    for (const n of nodes) {
      const where = trail ? trail + ' > ' + (n.name || n.type) : (n.name || n.type);
      if (!n || typeof n !== 'object') fail(`${where}：节点必须是对象`);
      if (!TYPES.has(n.type)) fail(`${where}：type「${n.type}」未登记，只允许 ${[...TYPES].join('/')}`);
      if (n.name) {
        if (seen.has(n.name)) fail(`${where}：name「${n.name}」重复，annotations 和改动点定位都靠它`);
        seen.add(n.name);
      }
      if (parentHasLayout && (n.x !== undefined || n.y !== undefined)) {
        fail(`${where}：父节点有 auto layout，子节点不能再写 x/y（位置由排版和间距决定）`);
      }
      if (n.type === 'text') {
        if (typeof n.text !== 'string') fail(`${where}：text 节点必须有 text 字段`);
        if (!n.font || !n.font.family || !n.font.style) fail(`${where}：text 节点必须有 font.family 和 font.style`);
        if (!(n.font.size > 0)) fail(`${where}：font.size 必须是正数`);
      }
      if (n.type === 'rect' && (!(n.width > 0) || !(n.height > 0))) fail(`${where}：rect 必须有正数 width/height`);
      if (n.type === 'frame' && n.layout) {
        if (!['HORIZONTAL', 'VERTICAL'].includes(n.layout.mode)) fail(`${where}：layout.mode 只能是 HORIZONTAL 或 VERTICAL`);
        if ((n.layout.mode && !n.width) && !n.layout.hugWidth) {
          // 允许 AUTO 宽度（hug），但要显式声明，避免猜
        }
      }
      if (Array.isArray(n.children) && n.children.length) {
        if (n.type !== 'frame') fail(`${where}：只有 frame 能有 children`);
        walk(n.children, !!n.layout, where);
      }
    }
  };
  walk(spec.nodes, false, '');

  if (spec.annotations && !Array.isArray(spec.annotations)) fail('annotations 必须是数组');
  for (const a of spec.annotations || []) {
    if (!a || !a.node || !a.text) fail('每条 annotation 必须有 node 和 text');
    if (!seen.has(a.node)) fail(`annotation 指向的节点「${a.node}」不存在（检查 name 拼写）`);
  }
}

function build(specs) {
  const specJson = JSON.stringify(specs, null, 2);
  return `// 由 figma-compile.js 从 design-spec.json 生成，不要手改。
// 改了设计请改 design-spec.json 再重新编译。
// 一次调用出多个状态：SPECS 是数组，每个元素对应画布上一个独立 frame。
const SPECS = ${specJson};

const hexToRgb = (h) => {
  const s = String(h).replace('#', '');
  if (s.length !== 6) throw new Error('颜色必须是 6 位十六进制：' + h);
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
};

const solid = (h, opacity) => {
  const p = { type: 'SOLID', color: hexToRgb(h) };
  if (typeof opacity === 'number') p.opacity = opacity;
  return p;
};

const created = [];
const fontCache = {};
// 非 auto layout 的父节点下，没写 x/y 的子节点按文档顺序垂直堆叠，
// 否则它们会全部叠在 (0,0)。显式写了坐标的节点照旧。
const nextFreeY = new WeakMap();

const placeChild = (node, s, parent) => {
  // 注意：layoutMode 在不使用 auto layout 时是字符串 'NONE'（真值），
  // 所以必须显式比较，不能用 if (parent.layoutMode) 判断。
  if (parent.layoutMode && parent.layoutMode !== 'NONE') return;
  const explicitX = typeof s.x === 'number';
  const explicitY = typeof s.y === 'number';
  if (explicitX) node.x = s.x;
  if (explicitY) node.y = s.y;
  if (!explicitY) {
    const cursor = nextFreeY.get(parent) || 0;
    node.y = cursor;
    nextFreeY.set(parent, cursor + node.height + (s.gapAfter || 0));
  }
  if (!explicitX) node.x = 0;
};

const ensureFont = async (font) => {
  const key = font.family + '|' + font.style;
  if (!fontCache[key]) {
    await figma.loadFontAsync({ family: font.family, style: font.style });
    fontCache[key] = { family: font.family, style: font.style };
  }
  return fontCache[key];
};

const applyFrameStyle = (node, s) => {
  if (s.fill) node.fills = [solid(s.fill, s.opacity)];
  else node.fills = [];
  if (s.radius !== undefined) node.cornerRadius = s.radius;
  if (s.stroke) {
    node.strokes = [solid(s.stroke, s.strokeOpacity)];
    node.strokeWeight = s.strokeWeight || 1;
    if (s.dashed) node.dashPattern = [4, 4];
  }
};

const buildNode = async (s, parent) => {
  let node;

  if (s.type === 'frame') {
    node = figma.createFrame();
    node.name = s.name || 'frame';
    const w = s.width || (s.layout && s.layout.hugWidth ? 100 : 0);
    const h = s.height || (s.layout && s.layout.hugHeight ? 100 : 0);
    node.resize(w, h);
    applyFrameStyle(node, s);
    parent.appendChild(node);

    if (s.layout) {
      const L = s.layout;
      node.layoutMode = L.mode;
      node.primaryAxisSizingMode = L.hugWidth && L.mode === 'HORIZONTAL' ? 'AUTO'
        : L.hugHeight && L.mode === 'VERTICAL' ? 'AUTO' : 'FIXED';
      node.counterAxisSizingMode = L.hugHeight && L.mode === 'HORIZONTAL' ? 'AUTO'
        : L.hugWidth && L.mode === 'VERTICAL' ? 'AUTO' : 'FIXED';
      const p = L.padding || [];
      if (p.length === 2) {
        node.paddingTop = p[0]; node.paddingBottom = p[0];
        node.paddingLeft = p[1]; node.paddingRight = p[1];
      } else if (p.length === 4) {
        node.paddingTop = p[0]; node.paddingRight = p[1];
        node.paddingBottom = p[2]; node.paddingLeft = p[3];
      }
      if (L.spacing !== undefined) node.itemSpacing = L.spacing;
      if (L.align) node.counterAxisAlignItems = L.align;
      if (L.primaryAlign) node.primaryAxisAlignItems = L.primaryAlign;
    }
  } else if (s.type === 'text') {
    node = figma.createText();
    node.name = s.name || 'text';
    const font = await ensureFont(s.font);
    node.fontName = font;
    node.characters = s.text;
    node.fontSize = s.font.size;
    parent.appendChild(node);
    if (s.width) {
      node.textAutoResize = 'HEIGHT';
      node.resize(s.width, node.height);
    } else {
      node.textAutoResize = 'WIDTH_AND_HEIGHT';
    }
    if (s.fill) node.fills = [solid(s.fill, s.opacity)];
    if (s.font.lineHeight) node.lineHeight = { unit: 'PIXELS', value: s.font.lineHeight };
    if (s.font.letterSpacing !== undefined) node.letterSpacing = { unit: 'PIXELS', value: s.font.letterSpacing };
    if (s.font.align) node.textAlignHorizontal = s.font.align;
  } else if (s.type === 'rect') {
    node = figma.createRectangle();
    node.name = s.name || 'rect';
    node.resize(s.width, s.height);
    applyFrameStyle(node, s);
    parent.appendChild(node);
  } else if (s.type === 'instance') {
    // 本地无法凭空造组件实例：建一个醒目的占位框，交付说明里要求替换
    node = figma.createFrame();
    node.name = '⚠️ 待替换为组件：' + (s.component || '未命名');
    node.resize(s.width || 100, s.height || 40);
    node.fills = [solid('#FF0000', 0.06)];
    node.strokes = [solid('#FF0000')];
    node.strokeWeight = 1;
    node.dashPattern = [4, 4];
    parent.appendChild(node);
  } else if (s.type === 'image') {
    node = figma.createFrame();
    node.name = '⚠️ 待替换为图片：' + (s.name || 'image');
    node.resize(s.width || 100, s.height || 100);
    node.fills = [solid('#000000', 0.06)];
    node.strokes = [solid('#FF0000')];
    node.strokeWeight = 1;
    node.dashPattern = [4, 4];
    parent.appendChild(node);
  } else {
    throw new Error('未知 type：' + s.type);
  }

  if (s.annotations && s.annotations.length) {
    try {
      node.annotations = s.annotations.map((t) => ({ label: t }));
    } catch (e) {
      // 该环境不支持 annotation 时不阻断出稿，交付说明里注明
    }
  }

  created.push(node.id);
  placeChild(node, s, parent);

  if (s.children) {
    for (const c of s.children) await buildNode(c, node);
  }

  return node;
};

// 已有内容下方留 80px 起排，避免盖住画布上原有的东西
const existing = [...figma.currentPage.children];
const baseY = existing.length ? Math.max(...existing.map((n) => n.y + n.height)) + 80 : 0;
const baseX = existing.length ? Math.min(...existing.map((n) => n.x)) : 0;
let cursorX = baseX;

const frames = [];
const createdRoots = [];
for (const spec of SPECS) {
  const root = await buildNode({
    type: 'frame',
    name: spec.page + '/' + spec.state,
    width: spec.frame.width,
    height: spec.frame.height,
    fill: spec.frame.background || '#FFFFFF',
    children: spec.nodes,
  }, figma.currentPage);

  // 多状态横向排开，状态之间留 80px；单状态时有显式 offset 就用它
  if (spec.offset) {
    root.x = spec.offset.x || 0;
    root.y = spec.offset.y || 0;
    cursorX = root.x + root.width + 80;
  } else {
    root.x = cursorX;
    root.y = baseY;
    cursorX = root.x + root.width + 80;
  }

  const anns = spec.annotations || [];
  if (anns.length) {
    try {
      root.annotations = anns.map((a) => ({ label: a.node + '：' + a.text }));
    } catch (e) {}
  }
  createdRoots.push(root);
  frames.push({ frameId: root.id, frameName: root.name, size: [root.width, root.height] });
}

figma.viewport.scrollAndZoomIntoView(createdRoots);

return {
  frames,
  frameIds: frames.map((f) => f.frameId),
  createdNodeIds: created,
  nodeCount: created.length,
};
`;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.error('用法：node figma-compile.js <design-spec.json> [输出文件]');
    console.error('  design-spec.json 可以是单个页面状态的对象，也可以是对象数组（一次出多个状态）。');
    process.exit(1);
  }
  const input = path.resolve(argv[0]);
  if (!fs.existsSync(input)) fail('文件不存在：' + input);

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (e) {
    fail('JSON 解析失败：' + e.message);
  }

  const specs = normalizeSpecs(spec);
  const labels = new Set();
  for (const one of specs) {
    validate(one);
    const label = one.page + '/' + one.state;
    if (labels.has(label)) fail(`「${label}」出现了两次，同一页面同一状态只能定义一次`);
    labels.add(label);
  }
  const code = build(specs);

  if (argv[1]) {
    const out = path.resolve(argv[1]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, code, 'utf8');
    console.log('已生成 ' + out + '（' + code.length + ' 字节）');
    console.log('把它作为 use_figma 的 code 参数，skillNames 传 "resource:figma-use,resource:figma-generate-design"。');
  } else {
    process.stdout.write(code);
  }
}

main();
