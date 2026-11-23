# SVG 出稿规范（design/ 布局清单 → svggen.cjs → SVG/PNG）

SVG 本身就是设计源：可 diff、可评审、可手工微调；PNG 只是栅格化结果。
「figma 导入包」那套（design-spec.json / HTML 渲染 / plugin 代码）已废弃删除。

## 文件与命令

```
design/
  layouts.json   布局清单（生成器输入，要提交）
  svg/           每帧一个 <frameId>.svg（设计源，要提交）
  boxes.json     量好的几何（--json 导出，自查溢出用）
design-images/   <frameId>.png（发群里的预览，要提交）
```

```bash
node <skillAssets>/svggen.cjs <需求目录>/design/layouts.json <需求目录>/design/svg --json=<需求目录>/design/boxes.json
node <skillAssets>/svg2png.cjs <需求目录>/design/svg <需求目录>/design-images --scale=3
```

- 渲染器校验失败会**整体退出、不出半成品**；报错信息带节点 tag，改清单重跑。
- `--scale` 是 deviceScale（PNG 像素 = css px × scale），默认 3。
- svg2png 找 Chrome/Edge 的顺序：`CHROME_PATH` 环境变量 → Windows/macOS/Linux 常见安装位；
  `--doctor` 自检。PNG 透明底，底图/面板自己给底色。

## layouts.json 结构

```jsonc
{
  "requirement": "一句话说明",
  "designTokens": {
    "colors": {
      "light": { "surface": "#FFFFFF", "onSurface": "#171A1F", "onSurfaceVariant": "#5B6270",
                 "primary": "#4D6BFE", "onPrimary": "#FFFFFF", "scrim": "rgba(0,0,0,0.54)", "shadow": "…" },
      "dark":  { "…": "…" }
    },
    "typography": { "title":  { "fontSize": 20, "fontWeight": 600, "lineHeight": 1.3, "colorToken": "onSurface" },
                    "intro":  { "fontSize": 15, "lineHeight": 1.4, "colorToken": "onSurfaceVariant" } },
    "radius": { "dialog": 16, "pill": 999 },
    "icons": { "size": 22, "strokeWidth": 1.75, "viewport": 24, "colorToken": "primary",
               "items": { "mic": { "svg": "<path …/>" } } }
  },
  "copy": { "zh": { "title": "欢迎使用 DoDroidAI" }, "en": { "title": "Welcome to DoDroidAI" } },
  "components": { "welcomeDialog": { "…一帧的节点树…" } },
  "frames": [ { "id": "F02_dialog_zh_light", "theme": "light", "locale": "zh", "fontScale": 1,
                "canvas": { "width": 360, "height": 800, "deviceScale": 3 },
                "background": { "type": "screenshot", "src": "assets/reference/home-light.png" },
                "scrim": true, "contentRef": "welcomeDialog",
                "changeScope": "dialog-only", "ac": ["AC-15"], "notes": "常规态" } ]
}
```

- `theme` 决定 colors 用 light 还是 dark；`locale` 没有隐式行为——textRef 自己带语言前缀
  （约定 `zh.title` / `en.title`，写进 copy 的键里）。
- `background`：`{type:"screenshot", src:…}`（相对 layouts.json 的真实截图，老页面用）
  或 `{type:"color", fill:"surface"}`（新页面）；缺省画 surface 底色。
- `scrim: true` 在底图上盖一层 `colors.scrim`。
- `content` 内联节点树，或 `contentRef` 引 `components` 里的复用树
  （同结构换主题/语言的帧复用一份，改一处全帧生效）。
- `radius`/`typography`/`icons.size` 支持 token 名引用（`"radius": "dialog"`）或直接写数值。

## 节点树

```jsonc
{ "type": "frame|text|rect|icon|image", "name": "唯一（帧内）",
  "x": 20, "y": 24,            // 可省：layout 容器里自动排
  "width": 320, "height": 48,  // 可省：内容撑开 / stretch 时撑满
  "fill": "surface", "radius": "dialog", "stroke": "…", "strokeWidth": 1, "opacity": 1,
  "layout": { "mode": "vertical|horizontal", "padding": "[上,右,下,左]|数字",
              "spacing": 8, "align": "start|center|end|stretch", "justify": "start|center|end" },
  "margin": [8, 0, 0, 0],      // 不对称间距（均匀间隔用 layout.spacing，别混用同一层）
  "children": [ "…" ],
  // text 专用：
  "text": "字面量", "textRef": "zh.features[0].title", "typography": "title", "align": "center",
  // icon 专用：
  "icon": "mic",               // designTokens.icons.items 的键
  // image 专用：
  "src": "assets/…", "width": 360, "height": 800 }
```

排版语义（和 svggen 实现一一对应）：

- 没有 x/y 的子节点在 layout 容器里按主轴排（vertical 沿 y、horizontal 沿 x）；
  非 layout 容器按文档顺序竖直堆叠。
- 文本按「CJK 全角 = 1em，其余 ≈ 0.55em，空格 0.28em」估宽换行；显式 `\n` 永远断行。
  这是**估宽**：出图后用 boxes.json / PNG 目检一遍长文案帧。
- `align: stretch` 只在 placement 阶段撑满父内容盒；容器自身宽高建议显式给，
  链路上每一层都要 stretch 才能从画布宽传到最内层。
- `radius: 999`（胶囊）渲染时钳到 min(w,h)/2，不会鼓成椭圆。
- 校验失败立刻退出：未知 type、name 帧内重复、textRef/icon 引用不存在、
  padding/margin 形状非法、canvas 尺寸非法。

## 何时直接改 SVG

SVG 是设计源，允许手工微调（比如给某帧挪 2px）——但**布局清单是唯一结构事实来源**，
结构级修改（加减节点、改文案）必须改 layouts.json 重渲染，手改 SVG 迟早和清单打架。
