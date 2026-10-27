# Figma 出稿与上传

阶段 2 的设计稿以 **Figma 画布上的真实图层**为正式产物，PNG 只是它的渲染结果。本文件规定：通道怎么走、生成什么、每次调用怎么省、拿不到链接时怎么办。

## 零、任务开始时：先查 token

**这是整个任务的第 0 步，不是阶段 2 的第 1 步。** 需求一受理、开始跑阶段 1 之前就要确认 Figma 授权可用。理由很实在：授权需要用户去浏览器里点，属于**会打断人的动作**，越早暴露越好——把它推到阶段 2，用户可能已经等了很久，才发现要回头做一次登录；而且万一授权本身有问题（桥接没装、账号不对），也还有整条流程的时间来调整，不必卡在出稿那一刻。

```bash
node assets/figma-auth.js check          # 退出码 0=可用，2=需授权
node assets/figma-auth.js authorize      # 会打开浏览器，等用户完成登录与同意
```

`check` 做两层判断，两层都要过：

1. **本地有效期**：读 `~/.mcp-auth/mcp-remote-v1/<md5(serverUrl)>_tokens.json` 的 `expires_at`，剩余不足 7 天即判为需要续期（提前续，别等过期）。
2. **服务端实际可用性**：拿 token 真打一次 `whoami`。**只看本地文件不够**——实测出现过文件写着还有两小时才到期、服务端已经返回 401 的情况（token 被别的授权流程顶掉）。`whoami` 是官方豁免额度的工具，可以当健康探针随便调。

`check` 退出码 2 时**立刻跑 `authorize`**，拿到新 token 再进入阶段 1，不要先往下跑再回头补授权。`authorize` 超时（默认 180 秒）说明用户没在浏览器里完成，停下来提示用户，不要反复重试。

需要在任务开始时就把这件事做完，是因为它是**唯一需要用户动手的环节**。其余所有出稿工作（写 spec、渲染、截图、捕获）都是自动的；只要授权这一步提前打通，后面 8 个阶段可以一路无阻地跑完，用户不会在流程中间被打断。

如果 `check` 通过，把账号、计划、席位记进需求卡片或 PRD 的环境信息里，后面判断额度和工具能力都用它，不用再查一次。

## 一、通道现实

DSH 能直连 Figma 官方远程 MCP，靠的是一层本地桥接：

```
DSH (mcp-client, stdio) → mcp-remote → OAuth → https://mcp.figma.com/mcp
```

配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml`，工具以 `mcp__figma__*` 出现在工具列表里。

**必须写成 `- insert:` 形式，不能写成顶层 `- id: mcp-figma`。** 这一点踩过坑：profile 的 patch 层是相对 bundle 树做的补丁，`- id: xxx` 是**修改已经存在的那一行**，`mcp-figma` 不在任何 bundle 里，于是这条补丁匹配不到任何行，被静默跳过——配置看着在文件里，启动后一条工具都没有，日志里连报错都没有。`- insert:` 才是「往树里加新行」：

```yaml
- insert:
    - id: mcp-figma
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: figma
        transport: stdio
        command: <node 绝对路径>
        args:
          - <mcp-remote>/dist/proxy.js
          - https://mcp.figma.com/mcp
          - --static-oauth-client-metadata
          - '{"client_name":"Claude Code","scope":"mcp:connect"}'
        env:
          HOME: <用户 HOME>
        toolCallTimeoutMs: 180000
        failOnStartupError: false
```

改完 `cordis.patch.yml` 需要重启 DSH 才生效（profile patch 在长驻表面会热重载，但新增插件行建议重启一次确认）。

四个必须知道的前提，缺一条就跑不通：

1. **必须带 `--static-oauth-client-metadata`，且 `client_name` 是 `Claude Code`。** Figma 的动态客户端注册按 `client_name` 做白名单，实测只有 `Claude Code` 放行，`Cursor` / `VS Code` / `DeepSeek Harness` / `MCP CLI Proxy` 全部 403。不写这个参数时 mcp-remote 用默认名 `MCP CLI Proxy`，**token 过期后重新注册会失败**——只是靠现有缓存才连得上。
2. **首次连接需要人工授权。** mcp-remote 会自动拉起浏览器，用户在浏览器里登录 Figma 并同意 `mcp:connect`。AI 代不了这一步，只能提示用户去做。token 落盘在 `~/.mcp-auth/mcp-remote-v1/<hash>/`，有效期 90 天，有 refresh_token。
3. **`env` 要显式给 `HOME`。** DSH 启动桥接进程时会剔除匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境变量，抹掉 HOME 会让 mcp-remote 找不到 `~/.mcp-auth` 缓存、反复重新授权。
4. **工具不是天生就有，而且配置写错时是静默的。** 桥接连不上时 harness 照常启动，只是工具列表里没有 `mcp__figma__*`——这个设计对「服务挂了不该拖垮 harness」是对的，但对配置写错同样静默，**写错和连不上看起来一模一样**。所以启动后看不到工具，第一步永远是查配置形态（是不是少了 `insert`），第二步才是查桥接能不能跑（见第九节）。

Figma REST API **不能创建或修改画布节点**。`FIGMA_TOKEN` 只能用来读取校验和拼链接，不要写出以为 PAT 能建节点的逻辑。

## 二、工具地图

实测 `tools/list` 返回 43 个工具，和出稿相关的：

| 工具 | 用途 | 计入限流 |
| --- | --- | --- |
| `whoami` | 查账号、计划、席位；排查权限问题的第一步 | 否 |
| `create_new_file` | 新建空白 Figma Design 文件，返回 `file_key` / `file_url` | 否 |
| `create_session` | 拿 `sessionId`，**所有文件类工具调用都必须带** | **否（实测）** |
| `use_figma` | 写画布：跑 Figma Plugin API 代码建 frame / text / auto layout | **是** |
| `get_screenshot` | 渲染指定 node 成 PNG，返回 `image_url` | **是** |
| `get_metadata` | 轻量 XML 大纲，校验图层结构用 | **是** |
| `get_design_context` | 读设计上下文（默认输出 React + Tailwind） | **是** |
| `upload_assets` | 上传图片／SVG 资产 | **否（实测）** |
| `generate_figma_design` | **默认出稿通道**：把运行中的网页捕获成画布图层，零额度 | **否（官方豁免）** |

**没有 `html_to_figma`。** 官方文档提到过，实际工具列表里不存在，别写进流程。

## 三、限流（决定出稿策略的硬约束）

Figma 的 MCP 限流按**计划 + 席位**分档，且**写画布工具也计入**：

| 席位 | Starter | Professional | Organization | Enterprise |
| --- | --- | --- | --- | --- |
| View / Collab | **20 次/月** | 20 次/月 | 20 次/月 | 20 次/月 |
| Full / Dev | — | 200 次/天，10 次/分 | 200 次/天，15 次/分 | 600 次/天，20 次/分 |

免费 Starter + View 席位只有 **20 次/月**，一次 `use_figma`、一次 `get_screenshot`、一次 `get_metadata` 都各扣一次。超限后所有计费工具返回：

```
You've reached the Figma MCP tool call limit on the Starter plan.
```

**默认策略：把额度当零来规划。** 阶段 2 的正规做法是**全程不消耗额度**，只有在明确需要干净图层结构时才动用 A 通道：

1. `design-spec.json` 在本地写全，`figma-compile.js` / `figma-render.js` / `figma-shot.js` 全部本地跑（零额度）。
2. **出稿统一走 B 通道**（`generate_figma_design` 捕获 `figma-render.js` 产出的 HTML），不计额度、不限次数，一个状态一个 captureId。
3. **不要用 `get_screenshot` / `get_metadata` 做验证**。截图用 `figma-shot.js` 本地截，结构自检靠 `figma-compile.js` 的校验器——这两个工具都计额度，一用就扣。
4. `whoami` 用来开工前确认账号与额度状态；`create_new_file`、`create_session`、`upload_assets` 实测也不计额度。
5. 只有在用户明确要求「可维护的原生图层（真实 text / auto layout / annotation）」且额度充足时，才走 A 通道 `use_figma`；走完要立刻在设计说明里记下消耗。

### 豁免清单与「零额度出稿」

官方 FAQ 把四个工具列为不计入限流：`add_code_connect_map`、`create_new_file`、`generate_figma_design`、`whoami`。实测另有 `create_session`、`upload_assets`、`send_code_to_figma` 也不计。**`use_figma`、`get_screenshot`、`get_metadata`、`get_design_context` 全部计费**，这一点与直觉相反，务必按此规划。

`generate_figma_design` 是整条流程的支柱：它把**运行中的网页**捕获成画布图层，且完全不计额度、不设次数上限（实测连续捕获多批页面均成功）。所以一个需求即使 MCP 额度为 0，也能把设计稿真实写进 Figma——只是图层来源是捕获的 DOM，不是 `use_figma` 那种干净的原生结构。两条通道的分工见第六节。

额度耗尽时不要重试、不要循环——所有计费工具都会持续返回同一条限流错误，重试只是浪费轮次。

## 四、阶段 2 要生成的文件

按每个「页面 × 状态」生成，全部先落**项目外临时目录**：

```text
<tmp>/figma/
  design-spec.json          # 图层结构的唯一事实来源，可 diff、可重放
  use-figma.js              # figma-compile.js 从 spec 生成的 Plugin API 代码
  html/<页面标识>/<状态>.html # figma-render.js 从 spec 生成的页面，捕获与截图都用它
  <页面标识>/<状态>.png      # 渲染结果，嵌进设计说明给人看
```

一份 spec 派生出三样东西，**不要手写其中任何一样**：

| 派生物 | 由谁生成 | 用途 |
| --- | --- | --- |
| `use-figma.js` | `figma-compile.js` | 走 `use_figma` 的干净结构通道（计额度） |
| `html/<页面>/<状态>.html` | `figma-render.js` | 走 `generate_figma_design` 捕获通道（零额度），同时用于本地截图 |
| `<页面>/<状态>.png` | `figma-shot.js` | 设计说明里展示，本地生成零额度 |

PNG 只用于文档展示，**不作为设计源**；Figma 稿改了要重新导出 PNG。手写第二份 HTML 或 Figma 代码是明确禁止的——一旦手写就会和 spec 漂移，评审对不上号。

## 五、design-spec.json 的结构

只描述 Figma 原生概念，不要塞 HTML 语义。字段固定，方便编译器直接吃：

```json
{
  "page": "task-list",
  "state": "空态",
  "frame": { "width": 375, "height": 812, "background": "#FFFFFF" },
  "offset": { "x": 0, "y": 0 },
  "nodes": [
    { "type": "text", "name": "title", "x": 16, "y": 60, "text": "暂无任务",
      "font": { "family": "Noto Sans SC", "style": "Medium", "size": 17 },
      "fill": "#1A1A1A" },
    { "type": "frame", "name": "filter-bar", "x": 0, "y": 88, "width": 375, "height": 48,
      "layout": { "mode": "HORIZONTAL", "padding": [12, 16], "spacing": 8, "align": "CENTER" },
      "children": [
        { "type": "rect", "name": "chip", "width": 72, "height": 32, "radius": 16, "fill": "#F2F3F5" }
      ] },
    { "type": "instance", "name": "primary-btn", "component": "Button/Primary",
      "x": 16, "y": 720, "width": 343, "height": 48 }
  ],
  "annotations": [
    { "node": "filter-bar", "text": "REQ-3：筛选条固定在标题下方" }
  ]
}
```

约定：

- `type` 只用 `frame` / `text` / `rect` / `instance` / `image` 五种。需要新类型先改 `assets/figma-compile.js` 的 `TYPES` 并同步本文件，别在需求里临时发明。
- **节点的 `name` 一旦写了就必须全局唯一**，编译时会查重。`annotations` 和改动点定位都靠它找到节点，建议每个节点都起名。
- 坐标相对父节点左上角。没写 `x`/`y` 的兄弟节点按文档顺序自上而下堆叠（编译器会维护游标），不会全部叠在原点。
- 有 auto layout 的父节点下**不能再写 `x`/`y`**，位置由 padding、间距和排版决定；编译器会直接报错拦住。
- `fill` 写六位十六进制；透明度另给 `opacity`（0–1）。
- `instance` / `image` 目前**只能生成红虚线占位框**：`use_figma` 禁止 `createImageAsync`，组件实例需要项目真有 Figma 组件库（`importComponentByKeyAsync` 要组件 key）。占位框名字分别是 `⚠️ 待替换为组件：<component>` 和 `⚠️ 待替换为图片：<name>`，**交付说明里必须写清需要设计师手动替换**。

### 字体

只能用**用户 Figma 账号里已有**的字体，本机装的字体不算数。实测账号内可用的中文字体只有 `Noto Sans SC`（另有 ZCOOL 系列的装饰字体）；**`PingFang SC` 不可用**，写了会 `loadFontAsync` 失败。

- 中文正文默认用 `Noto Sans SC`，字重 `Regular` / `Medium` / `Bold`。
- 英文与数字可用 `Inter`。注意 Figma 的字重名带空格：`Semi Bold`、`Extra Bold`、`Extra Light`，写成 `SemiBold` 会失败。
- 项目设计规范用的是别的字体时，换账号内最接近的，并在设计说明「与现有设计规范的差异」里写明替换关系和原因。

## 六、出稿：两条通道

先把本地能做的全做完（这一整步零额度）：

```bash
node assets/figma-compile.js <需求目录>/design-spec.json <需求目录>/use-figma.js
node assets/figma-render.js  <需求目录>/design-spec.json <需求目录>/html
node assets/figma-shot.js    <需求目录>/html <需求目录>
```

三条命令都不联网、不耗额度。`figma-compile.js` 校验不过就直接退出、**不产出半成品**：非法 JSON、缺 `page`/`state`、`nodes` 为空、`frame` 缺宽高、`type` 未登记、`name` 重复、`text` 缺 `font`/`text`/正数字号、`rect` 缺正数宽高、父节点有 auto layout 而子节点写了 `x`/`y`、`annotation` 指向不存在的节点。校验规则和编译器输出逻辑必须同步改，不要只改一边。

**默认走 B，需要干净结构才走 A。** B 不计额度、次数不限，是常规路径；A 每次调用都扣额度，只在用户明确要可维护原生图层、且确认额度够用时才走。B 出稿后如果之后额度宽裕、想补一层干净结构，可以再用 A 在同一份文件里做一版，两版并存并不冲突。

### B. `generate_figma_design`——零额度，默认通道

这条通道完全不计入限流，也看不到次数上限。它分三拍，脚本只管中间那一拍：

```text
① generate_figma_design { fileKey, sessionId }          → 返回 captureId（每个状态一个）
② node assets/figma-capture.js <需求目录>/html <captureId[,id2,...]>
③ generate_figma_design { fileKey, sessionId, captureId } → 轮询到 completed，拿 node-id
```

- **每个 captureId 只能消费一次**，且每个页面一个独立 ID。脚本按 `<页面标识>/<状态>.html` 的路径字典序处理，传 ID 时按同样顺序给；不确定顺序就先跑 `find <需求目录>/html -name '*.html' | sort` 看一眼，脚本也会把每个文件实际用的 ID 打到 stderr 上，事后能核对。
- **要按顺序拍**：先把该批次所有 captureId 都拿到手，再统一跑 capture 脚本，最后逐个轮询。不要「拿一个 id → 捕获 → 轮询」串行做，那样多状态会非常慢。
- **轮询不是一次就完**：第一次问通常返回 `**processing**`（原文大意 "This is normal. Capture data was submitted"），要每隔 5 秒重问一次，最多 10 次；拿到 `node-id=<n-n>` 才算成功。别把 `processing` 当成失败去重新捕获——重捕会浪费一个新 captureId。
- 脚本自己起本地 HTTP 服务、起无头 Chrome、注入官方 `capture.js`、等到真的向 Figma 提交成功才退出；**原 HTML 不会被改动**（注入只发生在临时副本上）。
- 失败会直接非零退出并说明原因：没找到 Chrome、页面没提交、captureId 被重复使用（非 2xx）。
- 捕获产物是 raw frames，不复用设计系统组件；需要精修时再配 A 通道在同一文件里改。
- 拿到 node-id 后记进设计说明的「Figma 出稿记录」。

### A. `use_figma`——结构精确，计额度

一次提交一整页的所有状态（多状态靠 `offset` 横向排开），不要一个状态一次调用。

```json
use_figma {
  "fileKey": "<file_key>",
  "sessionId": "<sessionId>",
  "code": "<use-figma.js 的内容>",
  "description": "<需求标识>：<页面>/<全部状态>",
  "skillNames": "resource:figma-use,resource:figma-generate-design"
}
```

`code` 上限 50000 字符，正常一份 spec 远低于此。成功返回 `{ frameId, frameName, size, createdNodeIds, nodeCount, annotations }`——**把这些 id 记下来**，链接和截图都要用。

两条通道的差别要如实写进设计说明：

| | A `use_figma` | B `generate_figma_design` |
| --- | --- | --- |
| 额度 | 每次计 1 次 | **不计，无次数上限** |
| 图层 | 真实 text / auto layout / annotation | 捕获的 DOM，结构较碎 |
| 设计变量 | 当前编译器不写变量绑定 | 捕获时带 `bindVariables=true`，会尝试绑到文件里的变量 |
| 适用 | 用户明确要可维护的原生图层且额度够 | **默认**；额度为 0 时唯一可行 |

### 硬规矩（A 通道）

`use_figma` 的执行环境有几条硬规矩，编译器已经遵守，手改生成结果时别破坏：

- 用 `return` 输出结果，**不要** `closePlugin`、不要包 async IIFE。
- 颜色分量是 0–1 的 `{r,g,b}`，透明度放在 paint 对象的 `opacity` 上。
- `fills` / `strokes` 是只读数组，整体重新赋值，不要 `push`。
- 文本必须先 `await figma.loadFontAsync()` 再写 `characters`。
- `resize()` 会把 sizing mode 复位成 `FIXED`，所以先 `resize()` 再设 `layoutSizing`。
- 换页必须 `await figma.setCurrentPageAsync(page)`，不能直接设 `figma.currentPage`。
- **禁止**使用 `loadAllPagesAsync`、`setPluginData`、`createImageAsync`。
- 顶层 frame 不要放在 `(0,0)`，避免和已有内容重叠；多状态用 spec 里的 `offset` 横向排开。

### 建文件与建 session

**文件组织：一个需求一个 Figma 文件，文件名就是「工作区 / 任务名」。文件内一个页面一个 `page`，一个状态一个 `frame`。**

```text
文件「<工作区名> / <需求标识>」        ← 每个需求 create_new_file 一次（不计额度）
  ├─ page「<页面标识>」
  │    ├─ frame：正常态
  │    ├─ frame：空态
  │    └─ frame：超长文案
  └─ page「<另一个页面>」
```

**不建文件夹、不需要文件夹 id。** 曾经设计过「一个工作区一个 Figma 文件夹」，放弃了：MCP 没有列/建文件夹的工具，文件夹要人工在网页里建，id 要人工从地址栏抄，而 Starter 计划还限一个文件夹、文件夹内 3 个文件——为了一份组织关系引入这么多人工步骤和硬上限，不划算。用文件名承载归属就够：文件落在 Drafts（**数量不限**），名字自带 `<工作区名> / ` 前缀，在 Figma 里按名字搜索、排序都是分好组的。将来要归档进团队文件夹，在网页里拖一下即可，那是用户的可选动作，不在流程里。

```json
create_new_file {
  "fileName": "<工作区名> / <需求标识>",
  "planKey": "team::<team_id>",
  "editorType": "design"
}
```

`planKey` 用 `whoami` 返回的 `plans[].key` 原样（形如 `team::1649805438937151831`）。**不要传 `projectId`**：没有对应文件夹，传了只会得到 `You do not have permission to add to this project`，把一次干净的成功变成一次失败。`create_new_file` 不计额度，每个需求单独建一个文件。

`<工作区名>` 用当前项目目录名（`basename` 工作目录）即可，不必问用户；`<需求标识>` 与 `docs/requirements/<需求标识>/` 用同一个字符串，这样 Figma 里的文件和仓库里的目录一一对应，事后好对账。

```json
create_session { "fileKey": "<file_key>", "description": "requirement-spec: <需求标识>" }
```

返回的 `sessionId` 必须在**后续每一次**文件类工具调用里原样带上，换文件也一样。

### 取图与链接

截图用 `get_screenshot { fileKey, nodeId, sessionId }`，返回 `image_url`，直接下载即可。批量导出多个节点用 `download_assets`。

链接两种写法，**别混**：

| 场合 | 格式 | 示例 |
| --- | --- | --- |
| 工具参数 `nodeId` | 冒号 | `2:2` |
| 浏览器链接 `?node-id=` | 连字符 | `https://www.figma.com/design/<fileKey>/<文件名>?node-id=2-2` |

设计说明里的「Figma 链接」列填浏览器链接（连字符形式）。

## 七、阶段 2 之后

- 设计通过后源文件迁回项目：`design-spec.json`、`use-figma.js`、`html/` 归到 `docs/requirements/<需求标识>/figma-import/`；PNG 归到 `docs/requirements/<需求标识>/design-images/`。
- **Figma 稿是设计源，不删除。** 与旧 Mockup 相反：Mockup 拿到真实截图后必须删，Figma 稿保留并在验收时核对。
- 阶段 7 做双向核对：Figma 稿最新版 ↔ 实现后的真实截图。偏差记入验收文档「设计实现偏差」，说明是设计变更还是实现偏差。
- 阶段 6/7 的真实截图照旧归档到 `docs/ui-screenshots/<页面标识>/<状态>.png`，**Figma 导出的图不能进截图库**，那个库只代表实际界面。

## 八、没有 Figma / 接不通时

判断顺序，命中即停：

1. `figma-auth.js check` 通过、工具列表里**有** `mcp__figma__*` → **走 B 通道**（`generate_figma_design`，零额度）出稿。这是正规路径，不是兜底。
2. 额度充足且用户明确要干净的原生图层 → 才走 A 通道（`use_figma`）。A 走完额度可能就归零了，后续任何截图/校验都不能再依赖计费工具。
3. B 通道失败（网络不通、Chrome 缺失、capture 一直 pending）→ 链接列写 `待上传（capture 未成功，源已就绪）`，把 `html/` 与 `design-spec.json` 放进 `figma-import/` 供人工导入，阶段 2 照样可以过。
4. 用户**没有 Figma 账号**或不愿授权 → 保留本地 `design-spec.json`、`use-figma.js`、`html/`、PNG，链接列写 `待上传（一键导入包已就绪）`，本地插件见 `assets/figma-plugin/`（完全离线兜底）。
5. 工具**根本没出现** → 先按第九节排查桥接；排查不通再退到第 4 档。

第 3–5 档都**不是常态**：正常机器上第 1 档一路走通，出稿零额度、零人工。之所以还保留这几档，是授权和网络这两件事本 skill 管不了，得有个如实记录的写法，不能假装成功。真要走到这几档，**不阻断阶段 2 通过**，只要在设计说明里写明当前状态和用户需要做什么。

## 九、常见失败与处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 一开始就该做的事 | — | 任务受理后先 `node assets/figma-auth.js check`；exit 2 立刻 `authorize` |
| `whoami` 返回 401，但本地 token 文件写着还没过期 | token 被别的授权流程顶掉 | 不要看 `expires_at` 就放心；`check` 会真打 `whoami` 验；失败就 `authorize` |
| 工具列表里没有 `mcp__figma__*`，但 `cordis.patch.yml` 里明明有这段配置 | **最常见**：写成了顶层 `- id: mcp-figma`。该 id 不在任何 bundle 行里，patch 匹配不到就被静默跳过，连报错都没有 | 改成 `- insert:` 包一层（见第一节），重启 DSH |
| 同上，但配置已经是 `insert` 形式 | 桥接进程起不来或握手失败 | 手动跑一次 `<node> <proxy.js> https://mcp.figma.com/mcp --static-oauth-client-metadata '{"client_name":"Claude Code","scope":"mcp:connect"}'` 看 stderr；确认 `env` 里有 `HOME` |
| 工具列表里没有，且日志里说插件包找不到 | 插件名不在 bundle 里也没装进 profile | `@deepseek-ai/dsh-mcp-client` 是 dsh 安装自带的，确认写对了包名；profile 里不需要另装 |
| 桥接启动后弹浏览器要求授权 | 无缓存或 refresh 失败 | 让用户完成一次授权；确认配置里有 `--static-oauth-client-metadata` 且 `client_name` 是 `Claude Code` |
| 注册返回 `403 Forbidden` | `client_name` 不在 Figma 白名单 | 只能是 `Claude Code`，不要试别的名字 |
| `You've reached the Figma MCP tool call limit` | 额度用尽（Starter 20 次/月） | 不要重试，所有计费工具都会持续返回同一条；改走 B 通道（不计额度） |
| `create_new_file` 报 `You do not have permission to add to this project` / `Invalid projectId` | 传了 `projectId` | 本流程不用文件夹，**不要传这个参数**；删掉重试一次即可 |
| `capture.js` 提交后 Figma 端一直 pending | HTML 里没注入 `capture.js`，或页面在提交前就被关掉 | 用 `assets/figma-capture.js`，它会自动注入并等到真的提交成功；不要用 `chrome --screenshot` 那种一次性模式 |
| `figma-capture.js` 报非 2xx | captureId 被重复消费 | 每个 captureId 只能用一次，重新调 `generate_figma_design { fileKey }` 换新 ID |
| `figma-capture.js` 报找不到 Chrome | 本机没有 Chrome/Chromium/Edge | 装一个，或用 `CHROME_PATH` 指定路径 |
| `loadFontAsync` 失败 | 字体不在账号里（如 `PingFang SC`） | 换 `Noto Sans SC` 或账号内相近字体，差异写进设计说明 |
| `Invalid font style` | 字重名格式错 | Figma 用 `Semi Bold` / `Extra Bold`，不是 `SemiBold` |
| 图层位置全乱、全叠在原点 | 父节点有 auto layout 却写了绝对坐标，或兄弟节点都没写 `y` | 有 layout 的父节点下不写坐标；无 layout 时靠编译器的堆叠游标 |
| `sessionId` 无效 / 缺 session | 没先 `create_session`，或没在每次调用带上 | 先建 session，之后每次文件类调用都带同一个 `sessionId` |
| 直连 `mcp.figma.com` 偶发 `read ECONNRESET` | 网络抖动（errno -54） | 加 2 秒退避重试；脚本里已内置，自己写临时脚本时也要加 |
| `use_figma` 报 plugin API 不可用 | 用了 `loadAllPagesAsync` / `setPluginData` / `createImageAsync` | 这三个禁用在远程执行环境，换等价写法 |
| 组件实例变成红虚线框 | `instance` 只能建占位框 | 正常行为，交付说明里写明需设计师替换 |
| 设计说明里图片不显示 | 引用了项目外绝对路径 | 阶段 2 通过后改成 `design-images/` 相对路径 |
