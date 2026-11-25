#!/usr/bin/env node
// svggen.js —— 设计稿直接生成 SVG：布局清单（layouts.json）→ 每帧一个 .svg。
// SVG 本身就是设计源（交付、评审、diff 的对象）；PNG 只是它的栅格化结果（svg2png.js）。
//
// 用法：node svggen.js <layouts.json> <输出目录> [--json=boxes.json]
//   输出目录里每个 frame 一个 <frameId>.svg；--json 额外导出排版计算结果，
//   供测试断言几何（不依赖浏览器就能验证布局）。
//
// 为什么中间还有一层布局清单：SVG 1.1 没有流式布局和文本自动换行，
// 手写绝对坐标又慢又容易漂；清单是生成器的输入（留在需求 assets 里），
// 不是交付物——交付物只有 SVG、PNG 和设计说明。
//
// 排版语义（细则见同目录 ../svg.md）：
//   - 节点树是唯一的布局事实来源；没有 x/y 的子节点在非 layout 父节点下按文档顺序竖直堆叠
//   - layout{mode:vertical|horizontal, padding, spacing, align, justify} 做流式布局
//   - 文本按「CJK 全宽 = 1em，其余 ≈ 0.55em」估宽换行；显式 \n 永远断行
//   - 没有浏览器参与，几何全部本地算出，因此可以离线、可重现
//
// 校验失败立刻退出、不产出半成品。

'use strict'
const fs = require('fs')
const path = require('path')

const TYPES = new Set(['frame', 'text', 'rect', 'icon', 'image'])
// 非中日韩/全角字符的平均宽系数。0.55 是 Roboto/Segoe 小写混排的经验值：
// 偏大只会让换行更保守（提前断行），不会撑破容器。
const LATIN_RATIO = 0.55
const SPACE_RATIO = 0.28

function fail(msg) {
  console.error(`svggen: ${msg}`)
  process.exit(1)
}

function isCpFullWidth(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文补充
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首～谚文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展
  )
}

// 估一行文本的像素宽。不做逐字精确度量（那要字体文件），
// 换行宁早勿晚——设计稿上「比真实浏览器早断一个词」比「溢出」好发现也好修。
function textWidth(str, fontSize) {
  let w = 0
  for (const ch of str) {
    const cp = ch.codePointAt(0)
    if (ch === ' ') w += fontSize * SPACE_RATIO
    else if (isCpFullWidth(cp)) w += fontSize
    else w += fontSize * LATIN_RATIO
  }
  return w
}

// 按最大宽度断行：显式 \n 优先，其次逐词/逐字。
// CJK 没有空格，逐字断是标准行为；拉丁词保持完整（词太长才硬切）。
function wrapText(text, fontSize, maxWidth) {
  const out = []
  for (const para of String(text).split('\n')) {
    if (para === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const seg of para.split(/(\s+)/)) {
      if (seg === '') continue
      const candidate = line + seg
      if (textWidth(candidate, fontSize) <= maxWidth || line === '') {
        // 词本身超宽时按字硬切（拉丁长串/无空格 CJK 都走这里）
        if (textWidth(candidate, fontSize) > maxWidth && line === '') {
          let piece = ''
          for (const ch of seg) {
            if (textWidth(piece + ch, fontSize) > maxWidth && piece !== '') {
              out.push(piece)
              piece = ch
            } else piece += ch
          }
          line = piece
        } else line = candidate
      } else {
        out.push(line)
        line = seg.trimStart() === '' ? '' : seg.trimStart()
        // 新行装不下这个词，继续逐字硬切
        while (textWidth(line, fontSize) > maxWidth) {
          let cut = ''
          for (const ch of line) {
            if (textWidth(cut + ch, fontSize) > maxWidth) break
            cut += ch
          }
          if (cut === '') break
          out.push(cut)
          line = line.slice(cut.length)
        }
      }
    }
    out.push(line)
  }
  return out
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function padOf(layout) {
  const p = layout?.padding ?? 0
  if (isNum(p)) return { top: p, right: p, bottom: p, left: p }
  if (Array.isArray(p) && p.length === 2) return { top: p[0], right: p[1], bottom: p[0], left: p[1] }
  if (Array.isArray(p) && p.length === 4) return { top: p[0], right: p[1], bottom: p[2], left: p[3] }
  fail(`layout.padding 只接受数字、[竖,横] 或 [上,右,下,左]：${JSON.stringify(p)}`)
}

// 不对称间距（如「标题→导语 8、导语→卖点 20」）用 margin 表达；
// 均匀间距用 layout.spacing，两者独立生效，别混用同一层。
function marginOf(node) {
  const m = node?.margin ?? 0
  if (isNum(m)) return { top: m, right: m, bottom: m, left: m }
  if (Array.isArray(m) && m.length === 2) return { top: m[0], right: m[1], bottom: m[0], left: m[1] }
  if (Array.isArray(m) && m.length === 4) return { top: m[0], right: m[1], bottom: m[2], left: m[3] }
  fail(`margin 只接受数字、[竖,横] 或 [上,右,下,左]：${JSON.stringify(m)}`)
}

// 变体帧展开：主帧声明 variants 后，渲染器自动派生兄弟帧（换主题/语言/字号/
// 画布宽），agent 只写一遍 content 树。手抄变体树是上一轮设计的最大时间黑洞：
// 7 帧里 5 帧是主帧的变体，全靠整棵复制，还抄出过不一致。
// 变体字段只做「覆盖」：theme/locale/fontScale 是标量，canvas 逐字段合并
// （只改宽不动高/倍率），background/content/contentRef 想换就整字段换。
// 变体不能再带 variants（不递归，防套娃）。
function expandVariants(frames) {
  const out = []
  for (const f of frames ?? []) {
    if (!Array.isArray(f.variants) || f.variants.length === 0) {
      out.push(f)
      continue
    }
    const base = { ...f }
    delete base.variants
    out.push(base)
    for (const v of f.variants) {
      const vf = structuredClone(base)
      delete vf.variants
      vf.id = v.id
      if (v.name !== undefined) vf.name = v.name
      for (const k of ['theme', 'locale', 'fontScale', 'background', 'content', 'contentRef']) {
        if (v[k] !== undefined) vf[k] = v[k]
      }
      if (v.canvas) vf.canvas = { ...vf.canvas, ...v.canvas }
      out.push(vf)
    }
  }
  return out
}

// ---------- 校验 ----------

// 帧内容：frame.content 内联，或 contentRef 复用 spec.components 里的组件
// （9 帧弹窗画一种结构，主题/文案不同——不复用就是抄 9 遍，改一处漏八处）。
function contentOf(spec, frame) {
  if (frame.content) return frame.content
  if (frame.contentRef) {
    const c = spec.components?.[frame.contentRef]
    if (!c) throw new Error(`frame ${frame.id}: contentRef「${frame.contentRef}」在 components 里找不到`)
    return c
  }
  return null
}

function validate(spec) {
  const errors = []
  // name 去重按帧算：contentRef 复用的组件会在多个帧里出现，跨帧重名是复用不是错误
  let names = new Set()
  // frame id 全局唯一：id 就是输出文件名，重了互相覆盖还不报错
  const frameIds = new Set()
  if (!spec || typeof spec !== 'object') return ['spec 不是对象']
  if (!Array.isArray(spec.frames) || spec.frames.length === 0) errors.push('frames 必须是非空数组')
  const tok = spec.designTokens ?? {}
  const typoKeys = Object.keys(tok.typography ?? {})
  const iconKeys = new Set(Object.keys(tok.icons?.items ?? {}))

  const walk = (node, frameId) => {
    const tag = `${frameId}/${node?.name ?? node?.type ?? '?'}`
    if (!TYPES.has(node?.type)) {
      errors.push(`${tag}: 未知 type「${node?.type}」，只允许 ${[...TYPES].join('/')}`)
      return
    }
    if (node.name) {
      if (names.has(node.name)) errors.push(`name 重复：${node.name}`)
      names.add(node.name)
    }
    for (const k of ['x', 'y', 'width', 'height', 'radius', 'opacity']) {
      if (node[k] !== undefined && !isNum(node[k])) errors.push(`${tag}: ${k} 必须是数字`)
    }
    if (node.type === 'text') {
      if (typeof node.text !== 'string' && typeof node.textRef !== 'string')
        errors.push(`${tag}: text 节点要有 text（字面量）或 textRef（copy 键）`)
      if (!node.typography) errors.push(`${tag}: text 节点要有 typography（token 键）`)
    }
    if (node.typography && !node.typography.fontSize && !typoKeys.includes(node.typography))
      errors.push(`${tag}: typography「${node.typography}」不在 designTokens.typography 里（${typoKeys.join(',')}）`)
    if (node.type === 'icon' && !node.icon) errors.push(`${tag}: icon 节点要有 icon（token 键）`)
    if (node.icon && !iconKeys.has(node.icon))
      errors.push(`${tag}: icon「${node.icon}」不在 designTokens.icons.items 里`)
    if (node.layout) {
      if (!['vertical', 'horizontal'].includes(node.layout.mode))
        errors.push(`${tag}: layout.mode 只允许 vertical/horizontal`)
      if (node.layout.align && !['start', 'center', 'end', 'stretch'].includes(node.layout.align))
        errors.push(`${tag}: layout.align 只允许 start/center/end/stretch`)
      if (node.layout.justify && !['start', 'center', 'end'].includes(node.layout.justify))
        errors.push(`${tag}: layout.justify 只允许 start/center/end`)
      padOf(node.layout) // 非法 padding 直接抛
    }
    for (const c of node.children ?? []) walk(c, frameId)
  }
  for (const f of spec.frames ?? []) {
    if (!f.id) errors.push('每个 frame 都要有 id（输出文件名用）')
    else if (frameIds.has(f.id)) errors.push(`frame id 重复：${f.id}（输出文件会互相覆盖）`)
    else frameIds.add(f.id)
    if (!isNum(f.canvas?.width) || !isNum(f.canvas?.height) || f.canvas.width <= 0)
      errors.push(`frame ${f.id ?? '?'}: canvas.width/height 必须是正数`)
    if (!['light', 'dark'].includes(f.theme)) errors.push(`frame ${f.id ?? '?'}: theme 只允许 light/dark`)
    let content = null
    try {
      content = contentOf(spec, f)
    } catch (e) {
      errors.push(e.message)
    }
    // name 去重按帧算：contentRef 复用的组件会在多个帧里出现，跨帧重名是复用不是错误
    names = new Set()
    if (content) walk(content, f.id ?? '?')
    else if (!f.background) errors.push(`frame ${f.id ?? '?'}: 既没有 content/contentRef 也没有 background，画不出东西`)
  }
  return errors
}

// ---------- 渲染 ----------

function makeCtx(spec, frame) {
  const theme = frame.theme ?? 'light'
  const colors = spec.designTokens?.colors?.[theme] ?? {}
  return {
    spec,
    frame,
    colors,
    color: (tokenRef) => {
      if (typeof tokenRef !== 'string') return tokenRef
      if (tokenRef.startsWith('#') || tokenRef.startsWith('rgba')) return tokenRef
      if (tokenRef === 'transparent' || tokenRef === 'none') return 'none'
      const v = colors[tokenRef]
      if (v === undefined) fail(`颜色 token「${tokenRef}」不在 designTokens.colors.${theme}`)
      return v
    },
    fontScale: frame.fontScale ?? 1,
  }
}

function typographyOf(ctx, t) {
  const tok = ctx.spec.designTokens?.typography ?? {}
  const raw = typeof t === 'string' ? tok[t] : t
  if (!raw) fail(`typography「${t}」不存在（可用：${Object.keys(tok).join(',')}）`)
  const fontSize = (raw.fontSize ?? 14) * ctx.fontScale
  return {
    fontSize,
    fontWeight: raw.fontWeight ?? 400,
    lineHeight: raw.lineHeight ?? 1.4,
    colorToken: raw.colorToken,
  }
}

function textRefOf(ctx, ref) {
  // {{LOCALE}} 是多语言约定：变体帧只覆盖 frame.locale，content 树不用重写，
  // 文案自动切语言（金标准的组件模板里就是这么写的，渲染器负责落地成具体键）。
  let v = ctx.spec.copy ?? {}
  const resolved = String(ref).replaceAll('{{LOCALE}}', ctx.frame.locale ?? 'zh')
  for (const raw of resolved.split('.')) {
    // 支持 features[0].title 这类数组下标
    const m = /^(\w+)((?:\[\d+\])*)$/.exec(raw)
    if (!m) fail(`textRef「${ref}」段「${raw}」解析不了`)
    v = v?.[m[1]]
    for (const idx of m[2].match(/\d+/g) ?? []) v = v?.[Number(idx)]
    if (v === undefined) fail(`textRef「${ref}」在 copy 里找不到`)
  }
  return String(v)
}

// 量一个节点：返回 {width, height, lines?}。
// availableWidth 是父内容盒给它的最大宽度（stretch / 换行都用它）。
function measure(ctx, node, availableWidth) {
  if (node.type === 'text') {
    const typo = typographyOf(ctx, node.typography)
    const raw = node.text ?? textRefOf(ctx, node.textRef)
    const maxW = node.width ?? Math.max(0, availableWidth)
    const lines = wrapText(raw, typo.fontSize, maxW)
    const w = node.width ?? Math.min(maxW, Math.max(...lines.map((l) => textWidth(l, typo.fontSize)), 0))
    return { width: w, height: lines.length * typo.lineHeight * typo.fontSize, lines, typo }
  }
  if (node.type === 'icon') {
    const size = node.width ?? node.height ?? ctx.spec.designTokens?.icons?.size ?? 22
    return { width: size, height: isNum(node.height) ? node.height : size }
  }
  if (node.type === 'image') {
    if (!isNum(node.width) || !isNum(node.height)) fail(`image「${node.name}」必须写 width/height`)
    return { width: node.width, height: node.height }
  }
  // frame / rect
  const pad = node.layout ? padOf(node.layout) : { top: 0, right: 0, bottom: 0, left: 0 }
  const inner = Math.max(0, (node.width ?? availableWidth) - pad.left - pad.right)
  const kids = node.children ?? []
  if (node.layout) {
    const gap = node.layout.spacing ?? 0
    if (node.layout.mode === 'vertical') {
      let h = pad.top + pad.bottom
      let maxW = 0
      kids.forEach((c, i) => {
        const m = measure(ctx, c, inner)
        const mg = marginOf(c)
        c._m = m
        // margin 与 spacing 并存：spacing 管均匀间隔，margin 管单侧修正
        h += mg.top + m.height + mg.bottom + (i > 0 ? gap : 0)
        maxW = Math.max(maxW, m.width)
      })
      return { width: node.width ?? maxW + pad.left + pad.right, height: node.height ?? h }
    }
    let w = pad.left + pad.right
    let maxH = 0
    kids.forEach((c, i) => {
      const m = measure(ctx, c, inner)
      const mg = marginOf(c)
      c._m = m
      w += mg.left + m.width + mg.right + (i > 0 ? gap : 0)
      maxH = Math.max(maxH, m.height)
    })
    return { width: node.width ?? w, height: node.height ?? maxH + pad.top + pad.bottom }
  }
  // 非 layout 父节点：子节点按文档顺序竖直堆叠（旧渲染器的同款规则）
  let h = pad.top + pad.bottom
  let maxW = 0
  for (const c of kids) {
    const m = measure(ctx, c, inner)
    const mg = marginOf(c)
    c._m = m
    h += mg.top + m.height + mg.bottom
    maxW = Math.max(maxW, m.width)
  }
  return {
    width: node.width ?? maxW + pad.left + pad.right,
    height: node.height ?? h,
  }
}

// 把量好的节点放进绝对坐标，同时产出 SVG 片段。
function place(ctx, node, x, y, box, out) {
  const m = node._m ?? measure(ctx, node, box.width)
  const w = m.width
  const h = m.height
  const attrs = []
  if (node.opacity !== undefined) attrs.push(`opacity="${node.opacity}"`)

  if (node.type === 'text') {
    const { lines, typo } = m
    const fill = ctx.color(node.fill ?? typo.colorToken)
    const lh = typo.lineHeight * typo.fontSize
    const anchor = node.align === 'center' ? 'middle' : node.align === 'end' ? 'end' : 'start'
    const tx = node.align === 'center' ? x + w / 2 : node.align === 'end' ? x + w : x
    // x/y 必须写在 <text> 上——SVG 文本默认原点，漏了就全部叠到 (0,0)
    const tspans = lines
      .map((l, i) => (i === 0 ? esc(l) : `<tspan x="${r2(tx)}" dy="${r2(lh)}">${esc(l)}</tspan>`))
      .join('')
    out.push(
      `<text x="${r2(tx)}" y="${r2(y + lh / 2 + typo.fontSize * 0.36)}" font-family="${FONT_STACK}" font-size="${r2(typo.fontSize)}" font-weight="${typo.fontWeight}" fill="${fill}" text-anchor="${anchor}" ${attrs.join(' ')}>${tspans}</text>`,
    )
    return { width: w, height: h }
  }
  if (node.type === 'icon') {
    const item = ctx.spec.designTokens?.icons?.items?.[node.icon]
    if (!item) fail(`icon「${node.icon}」不存在`)
    const size = node.width ?? ctx.spec.designTokens?.icons?.size ?? 22
    const color = ctx.color(node.fill ?? ctx.spec.designTokens?.icons?.colorToken ?? 'primary')
    // stroke-width 写 24 视口的值（1.75），外层 scale 会把它一起缩放
    const sw = ctx.spec.designTokens?.icons?.strokeWidth ?? 1.75
    out.push(
      `<g transform="translate(${r2(x)} ${r2(y)}) scale(${r2(size / 24)})" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" color="${color}" ${attrs.join(' ')}>${item.svg}</g>`,
    )
    return { width: size, height: size }
  }
  if (node.type === 'image') {
    out.push(
      `<image href="${esc(node.src)}" x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" preserveAspectRatio="xMidYMid slice" ${attrs.join(' ')}/>`,
    )
    return { width: w, height: h }
  }
  // frame / rect
  if (node.fill || node.type === 'frame') {
    const fill = ctx.color(node.fill ?? 'transparent')
    // SVG 会把 rx 钳到宽高一半——999 的胶囊意图是「 fully round」，
    // 得自己钳到 min(w,h)/2，否则宽矩形会鼓成椭圆
    const rx = Math.min(node.radius ?? 0, Math.min(w, h) / 2)
    if (fill !== 'transparent')
      out.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(rx)}" fill="${fill}" ${attrs.join(' ')}/>`)
    else if (rx > 0)
      out.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(rx)}" fill="none" ${attrs.join(' ')}/>`)
  } else if (node.radius > 0) {
    out.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(Math.min(node.radius, Math.min(w, h) / 2))}" fill="none" ${attrs.join(' ')}/>`)
  }
  if (node.stroke) {
    out.push(
      `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(Math.min(node.radius ?? 0, Math.min(w, h) / 2))}" fill="none" stroke="${ctx.color(node.stroke)}" stroke-width="${node.strokeWidth ?? 1}" ${attrs.join(' ')}/>`,
    )
  }

  // 子节点布局
  const pad = node.layout ? padOf(node.layout) : { top: 0, right: 0, bottom: 0, left: 0 }
  const contentX = x + pad.left
  const contentY = y + pad.top
  const contentW = Math.max(0, w - pad.left - pad.right)
  const kids = node.children ?? []
  if (node.layout) {
    const gap = node.layout.spacing ?? 0
    const vertical = node.layout.mode === 'vertical'
    // 主轴：vertical 沿 y 堆叠，horizontal 沿 x 排开（别写反——上一版就是这么坏的）
    const usedMain =
      kids.reduce((s, c) => {
        const mg = marginOf(c)
        return s + (vertical ? mg.top + c._m.height + mg.bottom : mg.left + c._m.width + mg.right)
      }, 0) + gap * Math.max(0, kids.length - 1)
    const mainStart = vertical ? contentY : contentX
    const mainLen = vertical ? h - pad.top - pad.bottom : contentW
    let cursor = node.layout.justify === 'center' ? mainStart + (mainLen - usedMain) / 2 : node.layout.justify === 'end' ? mainStart + mainLen - usedMain : mainStart
    for (const c of kids) {
      const cm = c._m
      const mg = marginOf(c)
      let cx, cy
      if (vertical) {
        cy = cursor + mg.top
        cursor += mg.top + cm.height + mg.bottom + gap
        // stretch 先改宽再算 cx，居中/贴边才不会用旧宽度
        if (node.layout.align === 'stretch' && !isNum(c.width)) cm.width = contentW
        cx = node.layout.align === 'center' ? contentX + (contentW - cm.width) / 2 : node.layout.align === 'end' ? contentX + contentW - cm.width : contentX
      } else {
        cx = cursor + mg.left
        cursor += mg.left + cm.width + mg.right + gap
        cy = crossY(node.layout, cm.height, contentY, h - pad.top - pad.bottom)
      }
      place(ctx, c, cx, cy, { width: cm.width }, out)
    }
  } else {
    // 文档顺序竖直堆叠；写了 x/y 的孩子用绝对坐标
    let cursor = contentY
    for (const c of kids) {
      const cm = c._m
      const mg = marginOf(c)
      const cx = c.x !== undefined ? x + c.x : contentX
      const cy = c.y !== undefined ? y + c.y : cursor + mg.top
      if (c.y === undefined) cursor += mg.top + cm.height + mg.bottom
      place(ctx, c, cx, cy, { width: contentW }, out)
    }
  }
  return { width: w, height: h }
}

function crossY(layout, childH, contentY, contentH) {
  if (layout.align === 'center') return contentY + (contentH - childH) / 2
  if (layout.align === 'end') return contentY + contentH - childH
  return contentY
}

const FONT_STACK = ctxFontStack()
function ctxFontStack() {
  // 出图环境（Windows）没有 Roboto/Noto Sans CJK，用系统近似；
  // 真机以系统字体为准——设计说明里要记录这次降级。
  return "'Segoe UI','Microsoft YaHei','Noto Sans SC',sans-serif"
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function r2(n) {
  return Math.round(n * 100) / 100
}

function shadowFilter(ctx) {
  const s = ctx.colors.shadow
  if (!s) return { def: '', use: '' }
  const m = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(s)
  const dy = /,\s*(\d+)px/.exec(s)
  const blur = /\s+(\d+)px\s+rgba/.exec(s)
  const alpha = m ? Number(m[1]) : 0.2
  const id = 'dlgShadow'
  return {
    def: `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${dy ? dy[1] : 8}" stdDeviation="${blur ? Number(blur[1]) / 2 : 12}" flood-color="#000000" flood-opacity="${alpha}"/></filter>`,
    use: ` filter="url(#${id})"`,
  }
}

function renderFrame(ctx, outDir, specDir) {
  const f = ctx.frame
  const W = f.canvas.width
  const H = f.canvas.height
  const out = []
  const shadow = shadowFilter(ctx)
  const content = contentOf(ctx.spec, f)

  let defs = shadow.def
  let body = []
  // 背景：纯色或参照截图。截图是「真实界面」的证据，不能用矩形假扮。
  if (f.background?.type === 'color' || typeof f.background === 'string') {
    body.push(`<rect width="${W}" height="${H}" fill="${ctx.color(typeof f.background === 'string' ? f.background : f.background.fill)}"/>`)
  } else if (f.background?.type === 'screenshot' && f.background.src) {
    const abs = path.resolve(specDir, f.background.src)
    if (!fs.existsSync(abs)) fail(`frame ${f.id}: 背景截图不存在：${f.background.src}`)
    const rel = path.relative(outDir, abs).split(path.sep).join('/')
    body.push(`<image href="${esc(rel)}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`)
  } else {
    body.push(`<rect width="${W}" height="${H}" fill="${ctx.color('surface')}"/>`)
  }
  if (f.scrim) body.push(`<rect width="${W}" height="${H}" fill="${ctx.color('scrim')}"/>`)

  if (content) {
    measure(ctx, content, W)
    const sw = shadow.use
    // 根节点带 fill 才套投影（弹窗容器）
    const inner = []
    place(ctx, content, content.x ?? 0, content.y ?? 0, { width: W }, inner)
    if (content.fill && content.type === 'frame') {
      // 给弹窗本体补投影：包一层 g
      body.push(`<g${sw}>${inner.join('')}</g>`)
    } else body.push(...inner)
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    defs ? `<defs>${defs}</defs>` : '',
    ...body,
    '</svg>',
  ]
    .filter(Boolean)
    .join('\n')
  return { svg, layout: collectLayout(ctx, content) }
}

function collectLayout(ctx, content) {
  // 导出量好的盒子，测试直接断言几何
  const boxes = []
  const walk = (n) => {
    if (n?._m && n.name) boxes.push({ name: n.name, type: n.type, width: r2(n._m.width), height: r2(n._m.height), lines: n._m.lines })
    for (const c of n?.children ?? []) walk(c)
  }
  if (content) walk(content)
  return boxes
}

// ---------- main ----------

function main() {
  const args = process.argv.slice(2)
  const layoutsPath = args[0]
  const outDir = args[1]
  const jsonArg = args.find((a) => a.startsWith('--json='))
  if (!layoutsPath || !outDir) {
    console.error('用法：node svggen.js <layouts.json> <输出目录> [--json=boxes.json]')
    process.exit(2)
  }
  if (!fs.existsSync(layoutsPath)) fail(`布局清单不存在：${layoutsPath}`)
  let spec
  try {
    spec = JSON.parse(fs.readFileSync(layoutsPath, 'utf8'))
  } catch (e) {
    fail(`布局清单不是合法 JSON：${e.message}`)
  }
  spec.frames = expandVariants(spec.frames)
  const errors = validate(spec)
  if (errors.length) {
    for (const e of errors) console.error(`  ✗ ${e}`)
    fail(`校验未过（${errors.length} 条），不产出半成品`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  const specDir = path.dirname(path.resolve(layoutsPath))
  const layoutAll = {}
  for (const f of spec.frames) {
    const ctx = makeCtx(spec, f)
    const { svg, layout } = renderFrame(ctx, path.resolve(outDir), specDir)
    const file = path.join(outDir, `${f.id}.svg`)
    fs.writeFileSync(file, svg)
    layoutAll[f.id] = layout
    console.log(`  ${path.basename(file)}`)
  }
  if (jsonArg) fs.writeFileSync(jsonArg.slice('--json='.length), JSON.stringify(layoutAll, null, 2))
  console.log(`已生成 ${spec.frames.length} 帧 SVG → ${outDir}`)
}

main()
