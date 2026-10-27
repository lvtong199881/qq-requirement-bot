#!/usr/bin/env node
// 把 design-spec.json 内联进插件骨架，产出可直接导入 Figma 的 code.js。
// 用法: node build-inline.js <design-spec.json> <输出目录>
// 插件 networkAccess 为 none，无法 fetch 本地文件，所以 spec 必须在构建时内联。

const fs = require('fs');
const path = require('path');

const [, , specPath, outDir] = process.argv;
if (!specPath || !outDir) {
  console.error('用法: node build-inline.js <design-spec.json> <输出目录>');
  process.exit(1);
}

const skillDir = path.resolve(__dirname, '..', '..');
const skeletonDir = path.join(skillDir, 'assets', 'figma-plugin');

const raw = fs.readFileSync(specPath, 'utf8');
let spec;
try {
  spec = JSON.parse(raw);
} catch (e) {
  console.error('design-spec.json 不是合法 JSON: ' + e.message);
  process.exit(1);
}

// 最小校验，避免把错的结构导进 Figma 才发现
const errors = [];
if (!spec.frame || !spec.frame.width || !spec.frame.height) errors.push('缺少 frame.width / frame.height');
if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) errors.push('nodes 不能为空');
const allowed = new Set(['frame', 'text', 'rect', 'instance', 'image']);
const walk = (nodes, prefix) => {
  for (const n of nodes || []) {
    const where = `${prefix}${n.name || '(未命名)'}`;
    if (!allowed.has(n.type)) errors.push(`${where}: type "${n.type}" 未登记，只允许 ${[...allowed].join(' / ')}`);
    if (n.type === 'text' && !n.font) errors.push(`${where}: text 节点必须有 font`);
    if (n.type === 'text' && !n.text) errors.push(`${where}: text 节点必须有 text`);
    if (n.layout && n.layout.mode && n.children) {
      for (const c of n.children) {
        if (c.x !== undefined || c.y !== undefined) {
          errors.push(`${where}: 父节点有 auto layout 时子节点 "${c.name}" 不能再写 x/y`);
        }
      }
    }
    if (n.children) walk(n.children, `${where} > `);
  }
};
walk(spec.nodes, '');

if (errors.length) {
  console.error('design-spec.json 校验失败：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

let code = fs.readFileSync(path.join(skeletonDir, 'code.js'), 'utf8');
// 骨架用 // >>> SPEC ... // <<< SPEC 包住待替换区，避免正则误吞后面的函数定义
const marker = /\/\/ >>> SPEC[\s\S]*?\/\/ <<< SPEC/;
if (!marker.test(code)) {
  console.error('骨架 code.js 里找不到 // >>> SPEC ... // <<< SPEC 标记区，骨架可能被改坏了');
  process.exit(1);
}
code = code.replace(
  marker,
  '// >>> SPEC 由 build-inline.js 自动替换，手改不会生效于生成产物\nconst SPEC = ' +
    JSON.stringify(spec) +
    ';\n// <<< SPEC'
);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'code.js'), code);
fs.copyFileSync(path.join(skeletonDir, 'manifest.json'), path.join(outDir, 'manifest.json'));
fs.copyFileSync(specPath, path.join(outDir, 'design-spec.json'));

console.log('已生成: ' + outDir);
console.log('  code.js（已内联 spec，' + spec.nodes.length + ' 个顶层节点）');
console.log('  manifest.json');
console.log('  design-spec.json');
console.log('下一步：Figma 桌面版 → Plugins → Development → Import new plugin from manifest → 选 manifest.json');
