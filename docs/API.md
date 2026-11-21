# API 参考

> 返回 [README](../README.md)

面板和 bridge 各有一个 HTTP 服务，都**只监听 127.0.0.1**。本文按进程分节：
先约定鉴权与错误格式，定义几个共享结构，再逐个接口列参数和响应字段。

另有一套**给 App 用的 API**，独立端口、独立鉴权（用户名密码 + token），
和上面两个面板服务不是一回事，见 [App API](#app-api)。

## 约定

### 端口

| 进程 | 默认端口 | 配置项 |
| --- | --- | --- |
| bridge | 7878 | `panel.port` |
| panel | 7879 | `panel.publicPort`（环境变量 `PANEL_PORT` 优先） |

### 鉴权

面板自身**不校验 token**，只靠回环地址。`panel.token` 配了的话，面板转发写操作到
bridge 时会带 `x-panel-token`，由 bridge 校验（没配 token 时 bridge 全部放行）。

### 错误

失败统一返回 `{ "ok": false, "error": "人话" }`：

| 状态码 | 场景 |
| --- | --- |
| 400 | 缺参数、JSON 不合法、阶段超时档位不对、文案占位符未知、会话里没有在跑的回合 |
| 404 | 详情里的 pid 已不在运行、未知路径 |
| 500 | 读写 `bot.config.json` 失败等 |

## 数据结构

### Group —— 一个会话的状态

出现在 `/api/summary`、`/api/status`、`/api/board` 的行、`/api/board/detail` 里。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `groupId` | string | 会话 id。App 建的会话是 `t` 开头的 threadId；`group-` 前缀的老数据是 QQ 时代的群号，只用于兼容 |
| `reqId` | string \| null | 绑定的需求标识，如 `welcome-dialog` |
| `stage` | string \| null | 当前阶段名 |
| `stageStatus` | string | `进行中` / `已完成` / `未开始` |
| `status` | string | 回合状态（gate 状态） |
| `waitingLabel` | string | 在等什么；空串表示没在等 |
| `turn` | number | 该会话已跑过的回合数 |
| `initiator` | object \| null | `{ userId, nickname, at }`，需求发起人 |
| `lastActiveAt` | number \| null | 最后一次活动的时间戳（ms） |
| `activeTurn` | ActiveTurn \| null | 当前正在跑的回合，空闲时 `null` |
| `stageStartedAt` | number \| null | ⚠️ 仅完整快照（`/api/status`）有 |
| `stages` | array | ⚠️ 仅完整快照有：`[{ name, status }]` |

### ActiveTurn —— 正在跑的回合

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `startedAt` | number | 回合开始时间戳 |
| `elapsedMs` | number | 已运行毫秒 |
| `idleMs` | number | 距最后一次事件过了多久 |
| `events` | number | 收到的事件数 |
| `childPid` | number \| null | dsh 子进程 pid |
| `childAlive` | boolean | 子进程是否还活着 |

### Instance —— bridge 进程

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pid` | number | 进程号 |
| `port` | number | 该 bridge 的 HTTP 端口 |
| `startedAt` | number | 启动时间戳 |
| `nodeVersion` | string | 如 `v24.14.0` |
| `cwd` | string | 工作目录 |
| `appApiPort` | number | App API 实际监听的端口；未启用时为 0 |

### Config —— 该实例的配置快照

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `profile` | string | dsh profile 名，通常 `qqbot` |
| `botName` | string | 对外自称（对话框里显示的名字） |
| `projectDir` | string | 需求落地的项目目录 |
| `model` | string \| null | 模型标识 |
| `heartbeatMinutes` | number | 心跳间隔 |
| `turnTimeoutMin` | number | 单回合超时 |

### Resources —— 进程资源

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `rssMb` | number | 常驻内存（MB） |
| `heapMb` | number | 堆占用（MB） |
| `externalMb` | number | 外部内存（MB） |
| `cpuPct` | number | 平均 CPU 占用百分比 |
| `uptimeMs` | number | 已运行毫秒 |

### LogEntry —— 一条日志

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `at` | number | 时间戳 |
| `level` | string | `info` / `warn` / `error` |
| `text` | string | 正文 |

---

## bridge（每个实例，7878）

### `GET /api/summary`

精简状态：需求大盘和实例页都靠它，**不含** `recentEvents`、`groups[].stages`、
`stageStartedAt`。

```jsonc
{
  "instance": { /* Instance */ },
  "config": { /* Config */ },
  "groups": [ { /* Group，无 stages / stageStartedAt */ } ],
  "resources": { /* Resources */ },
  "at": 1793000000000
}
```

### `GET /api/status`

完整状态：在 summary 基础上补 `groups[].stageStartedAt`、`groups[].stages`，
并带 `recentEvents`（最近 50 条 `LogEntry`）。给「详细信息」弹窗用。

### `GET /api/logs?n=100`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `n` | number | 100 | 条数，上限 1000 |
| `level` | string | — | 按级别过滤：`info` / `warn` / `error` |

响应：`{ "logs": [ /* LogEntry */ ] }`

### `GET /api/ping`

响应：`{ "ok": true, "pid": 80395 }`

### `POST /api/settings/apply`

由面板在保存配置后调用，热更新本实例，不用重启。

```jsonc
{ "messageTemplates": { "v2StageStart": "当前{{stage}}阶段中。" } }
```

响应：`{ "ok": true }`

### `POST /api/threads/stop`

| body 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `threadId` | string | 是 | 要终止的会话（老字段名 `groupId` 也认） |

终止该会话当前回合（杀掉 dsh 子进程）。

```jsonc
// 成功
{ "ok": true, "message": "已终止当前回合" }
// 没在跑 → 400
{ "ok": false, "error": "该会话当前没有在跑的回合" }
// 缺 id → 400
{ "ok": false, "error": "缺少 threadId" }
```

### `POST /api/threads/restart`

参数同 stop。先中断，等 300ms，再把状态从 running/blocked 拉回可执行，
然后走一遍正常的消息入口（等价于在对话框里发一句「继续」），从当前阶段接着跑。

响应：`{ "ok": true, "message": "已重启" }`

---

## panel（一个进程，7879）

### `GET /api/board`

需求大盘：后端已经把各实例的会话摊平成行，前端拿到直接画表格。

```jsonc
{
  "rows": [
    {
      "pid": 80395,            // 所属进程
      "unreachable": false,
      "error": null,
      // 其余字段就是 Group
      "groupId": "476230759",
      "reqId": "welcome-dialog",
      "stage": "需求收尾",
      "stageStatus": "已完成",
      "initiator": { "nickname": "张三" }
      // …
    }
  ],
  "alerts": 0,                 // 不可达的实例数
  "at": 1793000000000
}
```

### `GET /api/board/detail?pid=&groupId=`

点「详细信息」时才拉。大盘某一行展开：一个会话 + 它所在的进程。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pid` | number | 是 | bridge 进程号 |
| `groupId` | string | 否 | 不传则 `group` 为 `null` |

```jsonc
{
  "instance": { /* Instance */ },
  "config": { /* Config */ },
  "resources": { /* Resources */ },
  "group": { /* Group，含 stages 与 stageStartedAt */ }
}
```

实例不可达时返回 `{ "instance": {...}, "unreachable": true, "error": "..." }`。

### `GET /api/instances`

实例页：按进程维度。每项是 summary 结构；进程不可达时是占位
`{ instance: { pid, port, startedAt }, unreachable: true, error }`。

响应：`{ "instances": [ /* summary */ ], "at": 1793000000000 }`

### `GET /api/settings`

读配置，给设置页用。

```jsonc
{
  "ok": true,
  "messages": [
    {
      "key": "ack",                 // 模板标识
      "group": "回执（消息 1）",
      "label": "有进行中阶段",
      "desc": "",
      "vars": ["stage", "duration"],
      "defaultTemplate": "当前{{stage}}阶段中，已进行 {{duration}}。",
      "template": "当前{{stage}}阶段中，已进行 {{duration}}。",
      "custom": false               // 是否被改过
    }
  ],
  "messageVars": { "stage": "阶段名，如「开发」" },   // 所有可用变量及说明
  "stageTimeouts": {            // 分阶段回合超时（分钟）
    "default": 30,              // 其他阶段
    "dev": 60,                  // 开发（含返工修正）
    "test": 60,                 // 测试
    "acceptance": 60            // 验收
  },
  "timeoutOptions": [10, 15, 30, 60]   // 面板下拉只给这几档
}
```

配置文件读失败时返回 `{ "ok": false, "error": "..." }`。

### `POST /api/settings/save`

保存配置 → 落盘 → 通知所有实例热更新。只传要改的字段，一个都不传会 400。

```jsonc
{ "messageTemplates": { "v2StageStart": "当前{{stage}}阶段中。" } }
{ "stageTimeouts": { "default": 30, "dev": 60, "test": 60, "acceptance": 60 } }
```

`stageTimeouts` 的四个键都必须给，且只能是 `10 / 15 / 30 / 60`——别的值返回 400，
避免把回合切成碎片。保存后热更新会同时把 `default` 同步到旧的 `turnTimeoutMs`。

响应 = 保存后的设置（同 `GET /api/settings`），外加每个实例的热更新结果：

```jsonc
{
  "ok": true,
  "messages": [ /* … */ ],
  "hotReloaded": [
    { "pid": 80395, "ok": true },
    { "pid": 81234, "ok": false, "error": "fetch failed" }
  ]
}
```

### `GET /api/logs?pid=&n=200`

先按 `pid` 找到实例，再转发到它的 `/api/logs`。不分页，一次取最近 N 条。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `pid` | number | 第一个实例 | bridge 进程号 |
| `n` | number | 200 | 条数，上限 1000 |

响应：`{ "logs": [ /* LogEntry */ ] }`

### `POST /api/threads/stop` / `POST /api/threads/restart`

参数与响应和 bridge 的同名接口一致，区别是面板会**先找到持有该会话的实例**再转发：

```jsonc
{ "threadId": "t1a2b3c4d5e6" }
```

找不到任何实例服务这个会话时返回 `{ "ok": false, "error": "没有实例在服务会话 t1a2b3c4d5e6" }`。

---

# App API

给 Flutter App 用的服务端，**和上面两个面板服务完全独立**：

| | 面板 bridge / panel | App API |
| --- | --- | --- |
| 监听 | 只 127.0.0.1 | `api.host`，默认 0.0.0.0 |
| 鉴权 | 无 / `x-panel-token` | 用户名密码登录，`Authorization: Bearer <token>` |
| 能力 | 停会话、重启、改配置、看日志 | 看需求、发消息、通过/打回、管账号 |
| 暴露公网 | ❌ 绝对不行 | ✅ 这才是给手机用的那个 |

之所以必须分开：面板有 `POST /api/threads/stop`、`POST /api/settings/apply` 这类能搞坏
运行状态的接口，而且 `src/ui/server.js` 里 token 为空时**直接放行**。那个东西一旦
公网可达，等于把整台机器（含 git 仓库和模型凭证）交出去。

启用方式见 [CONFIG.md](CONFIG.md) 的 `api` 段。默认开（`bot.config.example.json` 里是 `true`）。

## 鉴权

### 账号模型

- 只有一个角色维度：`admin`（系统管理员）/ `member`（普通成员）
- **启动时会建一个预设管理员** `admin` / `123456`，只在用户表为空时创建
- 表非空之后，新注册的账号一律是 `member`；要提权得由管理员在 App 里改
- 预设账号没有任何特权豁免：能被降级、能停用，也受「最后一个管理员」约束
- 改过密码之后，`/api/auth/status` 就不再返回预设账号（见下）
- 用户名 2–20 字符，允许中文；密码 6–128 字符，用 `scrypt` 存哈希
- 不设邮箱，也不做找回密码——忘了让管理员重置
- 最后一个管理员不能降级、不能停用（否则只能改 JSON 救场）

### token

HS256，自带 `iat`/`exp`，有效期 7 天。签名密钥在首次启动时生成，
落在 `.state/session.key`，重启后旧 token 仍然有效。

**每个请求都会重新查用户表**，不信任 token 里带的角色。所以管理员把某人降级或
停用后，那个人手上的旧 token **立刻失效**——不用等它过期。

### 限流

登录和注册按 IP 计：10 分钟内失败 20 次后返回 `429`。IP 优先取
`cf-connecting-ip`，其次 `x-forwarded-for` 首段，最后才是 socket 地址。

## 接口

### `GET /healthz`

不需要登录，用来探测隧道通不通。

```jsonc
{ "ok": true, "uptimeSec": 1234 }
```

### `GET /api/auth/status`

App 首屏据此决定「显示注册还是只显示登录」，以及要不要把初始账号写出来。

```jsonc
// 刚装好、预设管理员还没改过密码
{
  "ok": true,
  "needsFirstAdmin": false,
  "presetAdmin": "admin",
  "presetPassword": "123456"
}
```

```jsonc
// 改过密码、或者本来就没有预设账号
{ "ok": true, "needsFirstAdmin": false, "presetAdmin": null, "presetPassword": null }
```

- `needsFirstAdmin`：一个可用管理员都没有。预设账号建好之后基本总是 `false`
- `presetAdmin` / `presetPassword`：**只在预设账号还是初始密码、且仍是可用管理员时**给出。
  改过密码或降级之后都变 `null`——继续返回一串登不进去的账号是最糟的提示。

预设密码是固定的、写在代码里，所以返回它不泄露任何东西；它只是让新装机的人
不用去翻文档就知道用什么登录。

### `POST /api/auth/register`

```jsonc
{ "username": "阿宝", "password": "pass1234", "nickname": "产品阿宝" }
```

`nickname` 可省略，省略时用 username。成功：

```jsonc
{
  "ok": true,
  "token": "eyJhbGci...",
  "user": { "id": "...", "username": "阿宝", "role": "member", "roleLabel": "普通成员", ... },
  "notice": ""
}
```

`notice` 只在真的当上管理员时非空。**因为有预设管理员，正常情况下注册拿到的是
`member`，`notice` 是空串**——只有把用户表清空后注册才会是管理员（那时
`notice` 是「你是第一个注册的，已自动成为系统管理员」）。

失败：`400` + `{ "ok": false, "error": "这个用户名已经有人用了" }`。

### `POST /api/auth/login`

```jsonc
{ "username": "阿宝", "password": "pass1234" }
```

成功返回 `{ ok, token, user }`。失败一律 `401` + `"用户名或密码不对"`——
**不区分"没这个人"和"密码错"**，否则等于免费提供用户名存在性探测。

### `GET /api/auth/me`

需要登录。返回当前用户 + 他能做什么：

```jsonc
{
  "ok": true,
  "user": { "id": "...", "role": "member", "roleLabel": "普通成员", ... },
  "can": {
    "startRequirement": false,
    "confirm": false,
    "command": false,
    "comment": true,
    "read": true
  }
}
```

前端拿 `can` 决定按钮置灰，而不是自己写 `if (role === 'admin')`。
规则变了只改服务端一处。

## 群与需求（thread）

App 里的「群」在服务端就是一个 thread，id 形如 `t1a2b3c4d5e6`，在编排层里直接当作原来的 `groupId` 用——状态机、并发槽、worktree 池、产物校验、git 操作全部不用改。

群是容器，聊天和需求都在群里：**不 @ 需求 bot 就只是聊天，@ 一句才开始跑需求**。所以群有两种形态——还没提过需求的群（`mode: "chat"`、`pending: true`，没有 `name`/`stage`），和已经绑上需求的群（`mode: "requirement"`，有 `name`、`stage`、`stages`）。`groupName` 是建群时起的名，一直不变；`name` 是需求名，随流程走。

`mode` 一旦变成 `requirement` 就不会退回 `chat`：它决定「这条 @ 是接着当前需求说，还是开一条新需求」，来回切换会让这个判断变得不可预测。

### `GET /api/threads`

需要登录。**只返回你已经加入的群**——群是私有的，系统管理员也一样：
能管所有账号不等于能偷看所有群。

```jsonc
{
  "ok": true,
  "threads": [
    {
      "threadId": "t1a2b3c4d5e6",
      "groupName": "首页改版",
      "mode": "requirement",
      "pending": false,
      "name": "首页加欢迎弹窗",
      "reqId": "REQ-0007",
      "stage": "开发",
      "stageStatus": "进行中",
      "status": "waiting",
      "waitingLabel": "",
      "turn": 3,
      "initiator": { "userId": "...", "nickname": "产品阿宝" },
      "lastActiveAt": 1730000000000,
      "running": true,
      "needsMe": false,
      "stages": [ { "name": "需求澄清", "status": "已完成" }, ... ],
      "featureBranch": "feat/welcome-modal",
      "lastSeq": 42,
      "lastReadSeq": 40,
      "unread": 2,
      "lastMessage": {
        "seq": 42,
        "role": "bot",
        "userId": "u_bot",
        "nickname": "AI员工",
        "kind": "text",
        "text": "这一轮我先拆成三块，你看看顺序对不对"
      },
      "memberCount": 3,
      "myRole": "member",
      "canAct": true
    }
  ]
}
```

- `groupName` —— 群名（建群时起），需求还没起名时列表拿它当标题
- `mode` —— `chat`（只是聊天）/ `requirement`（跑过需求，但群里不 @ 仍然只是聊天）
- `pending` —— `true` 表示这个群还没提过需求，此时 `name`/`stage` 为 `null`、`stages` 为空
- `needsMe` —— 该你拍板了（等价于 `stageStatus === "等你确认"`），列表页拿它做置顶和红点
- `lastSeq` —— 这条需求最后一条消息的序号，App 用它当增量拉取的游标
- `lastReadSeq` —— 你读到哪儿了（只进不退）
- `unread` —— 别人发的、比 `lastReadSeq` 新的消息条数，列表页拿它做红点。**自己发的不算**：自己说句话就冒红点，那红点就不表示「有新东西我还没看」了
- `lastMessage` —— 最后一条消息的摘要，列表卡片第二行就是它；群里一条消息都没有时为 `null`，「谁发的」和「说了什么」分开给，App 才知道要不要拼「我：」
  - `role`（`user`/`bot`）、`userId`、`nickname` —— 谁说的
  - `kind` —— 消息类型；图片和文件没有正文，`text` 已经换成 `[图片]`、`[文件]` 这样的占位
  - `text` —— 一句话摘要；提问卡片用它的标题，比「[提问]」有用
  - 服务端不拼「我：」这类前缀：「我」是谁取决于看的人，那是 App 的事
- `canAct` —— 当前用户能不能通过/打回（普通成员为 `false`）

### `POST /api/threads/:id/read`

上报「我读到第 seq 条了」，用来消列表页的红点。App 在拉到消息后调用。

```jsonc
{ "seq": 42 }
```

返回 `{ ok: true, lastReadSeq: 42 }`。位置**只进不退**：详情页和列表页会并发刷新，一个乱序的旧请求不该让红点重新亮起来。没加入这个群返回 `403`。

### `POST /api/threads`

建群。需要 `startRequirement` 权限（只有 admin）。

```jsonc
{ "name": "首页改版" }
```

只有一个入参 `name`（群名，去空白后超过 40 字返回 `400`），**不接受需求文本**——需求等群里 @ 了需求 bot 再说。成功返回 `{ ok: true, threadId, thread }`，`thread.pending` 为 `true`、`thread.mode` 为 `"chat"`。

没有权限返回 `403`（`error: "建群需要系统管理员权限"`）。

### 在群里提需求

在聊天模式的群里发一条 **@ 了需求 bot** 的消息，编排层就据此建 flow。这一步需要 `startRequirement` 权限（`403` 文案 `"提需求需要系统管理员权限"`，且被拒的那句话不会落库）。

请求体里可以显式带上 `mentions`，值是机器人账号的 id：

```jsonc
{ "text": "给首页加个欢迎弹窗", "mentions": ["u_bot"] }
```

不传 `mentions` 时，服务端也会从文本里认手打的 `@AI员工`。名字取自机器人账号的昵称（`config.bot.name`，缺省 `AI员工`），改了就只认新名字。@ 判据、去 @、模式切换都在 `src/im/router.js` 里，测试见 `test/engine-channel.js`。

机器人本身是账号表里的一个真实账号（`role: "bot"`、`username: "bot"`、`id: "u_bot"`，服务启动时自动建）：消息归属它、@ 指向它，但它不能登录，也不能改角色、停用或重置密码。账号接口里它带 `isBot: true`。

之后的规矩——**判据只有一条：有没有 @ 需求 bot**，需求群里也一样：

| 群状态 | 不 @ | @ 需求 bot |
| --- | --- | --- |
| `chat` | 只落库，谁都不打扰 | 建 flow，群变 `requirement` |
| `requirement` | 只落库，谁都不打扰 | 转给引擎（接着答问题、补信息、拍板），不重开需求 |

需求群里不豁免 @：同一个群平时也在聊别的事（谁去拿快递、按钮位置要不要换），
全转给引擎等于让 agent 把无关的话当需求上下文吃进去，一句「嗯」也可能触发
一轮真金白银的回合。要不要让 agent 听见，始终由说话的人用 @ 明确表示。

唯一的例外是界面上的**通过 / 打回**按钮：它是按钮不是打字，不要求再 @ 一次，
服务端按 `confirm` 权限判完后强制转给引擎。

### `GET /api/threads/:id`

单条详情，结构同上，另带 `canAct`。不存在返回 `404`。

### `GET /api/threads/:id/messages?since=&limit=`

消息流，按 `seq` 升序。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `since` | number | 0 | 只返回 `seq > since` 的消息 |
| `limit` | number | 200 | 上限 500；超限时返回**最新**的 N 条 |

```jsonc
{
  "ok": true,
  "messages": [
    {
      "seq": 7,
      "at": 1730000000000,
      "role": "bot",
      "kind": "text",
      "payload": { "text": "收到，先做需求澄清：这个弹窗给谁看？" }
    }
  ],
  "lastSeq": 7
}
```

`role` 是 `user`（团队里的人说的）或 `bot`（机器人账号说的，`userId` 是 `u_bot`、`nickname` 是它的昵称）。

`kind` 与对应 `payload`：

| kind | payload | 说明 |
| --- | --- | --- |
| `text` | `{ text }` | 普通文本 |
| `image` | `{ url, name }` | 设计稿，`url` 可直接下载 |
| `file` | `{ url, name, size }` | 交付文件 |
| `stage` | `{ stage, status }` | 阶段变化，App 可渲染成进度卡片 |
| `decision` | `{ title, items }` | 待决策项（旧版，只有文字） |
| `ask` | 见下 | 提问卡片：让用户在消息流里直接勾选、提交 |

用户消息上还可能带 `askSeq`（回答的是哪张卡片）和 `answers`（勾了什么）：

```jsonc
{
  "seq": 8,
  "role": "user",
  "kind": "text",
  "payload": {
    // 纯文本版本给不认 answers 的客户端看：问题一行，选项缩进一行
    "text": "弹窗时机？\n  A. 首次启动（推荐）",
    "askSeq": 7,
    "answers": [{ "qid": "q1", "optionIds": ["a"], "input": "" }]
  }
}
```

App 自己按 `answers` + 对应卡片渲染（问题一行、选项缩进且字号更小颜色更淡），
`text` 只是给面板、引擎日志这类纯文本消费者的兜底。

`ask` 的 `payload`：

```jsonc
{
  "title": "需要你拍板",
  "submitLabel": "提交",
  "questions": [
    {
      "id": "q1",
      "title": "弹窗什么时候出现比较合适？",
      "kind": "single",          // single 单选 / multi 多选
      "allowInput": true,        // 允许「都不是，自己写」
      "inputLabel": "都不是？自己写",
      "options": [{ "id": "a", "label": "首次启动（推荐）" }, { "id": "b", "label": "每次启动" }]
    }
  ]
}
```

一张卡片最多 26 个问题、每题最多 26 个选项；`kind` 不认识的一律当 `single`。
通过/打回也是一张 `ask` 卡（一道题、两个选项 `approve`/`reject`），所以 App 里不再有单独的按钮——
**勾选后点提交，就是原来那个「通过」或「打回」**，权限判定完全一样。

消息存成每 thread 一个 JSONL 文件（`.state/messages/<threadId>.jsonl`），
只追加不改写。`text` 超过 20000 字会被截断。

### `POST /api/threads/:id/messages`

说一句话。任何登录用户都能发；内容怎么处理看群模式和有没有 @ 需求 bot（见上面「在群里提需求」的表格）。

```jsonc
{ "text": "给新用户看，第一次打开的时候弹" }
```

可选 `mentions: ["u_bot"]`，不传就按文本里的 `@AI员工` 判断。

也可以带 `answers` + `askSeq` 交提问卡片：带了 `answers` 就等同于点了卡片上的提交，
**不需要再 @ 需求 bot**（点按钮不该再要求打一次 @），权限按 `confirm` 判。

```jsonc
{
  "text": "1. 弹窗时机？ A. 首次启动（推荐）",
  "askSeq": 7,
  "answers": [{ "qid": "q1", "optionIds": ["a"], "input": "" }]
}
```

`optionIds` 为空表示这题靠 `input` 里的自写内容回答。`input` 最多 2000 字。

成功返回 `{ ok: true, accepted: true }`，同样**不等回合跑完**。

### `POST /api/threads/:id/approve`

通过当前阶段的产出。需要 `confirm` 权限（admin）。

无请求体。成功返回 `{ ok: true, accepted: true }`。

普通成员调用返回 `403`：

```jsonc
{
  "ok": false,
  "error": "通过和打回只有系统管理员能操作",
  "code": "forbidden",
  "role": "member",
  "roleLabel": "普通成员"
}
```

> 设计取舍：App 里普通成员**看得见**这两个按钮，点了才提示没权限。
> 藏起来会让人以为是 bug，弹一句"为什么不行"更省沟通。

### `POST /api/threads/:id/reject`

打回。需要 `confirm` 权限。**`reason` 必填**——只说"不行"，agent 没法改。

```jsonc
{ "reason": "按钮颜色不对，应该用品牌蓝" }
```

### 群成员与入群

群是**私有**的：列表、详情、消息、发言都只给已经加入的人。非成员访问详情/消息返回
`403`，带 `code: "not_member"`、`error: "你还没加入这个群"`——App 靠这个 code 区分
「没权限进这个群」和「登录过期」，前者给「加入」按钮，后者才回登录页。

角色三种，跟 QQ 一套习惯：

| role | 谁 | 能做什么 |
| --- | --- | --- |
| `owner` | 建群的人（真人，不是机器人） | 改群名、指定/取消群管理员 |
| `admin` | 群主指定的人 + 机器人账号（自动） | 改群名 |
| `member` | 其余加入的人 | 聊天、@ 需求 bot、在卡片上拍板（拍板还要系统管理员权限） |

系统管理员也只看得到自己加入的群：能管账号不等于能偷看所有群。

#### `GET /api/threads/:id/preview`

任何登录用户可调，用来在加入前确认「这是哪个群、几个人」。不含任何消息。

```jsonc
{ "ok": true, "preview": { "threadId": "t1a2b3c4d5e6", "groupName": "首页改版",
  "memberCount": 3, "joined": false, "ownerNickname": "产品阿宝" } }
```

群不存在返回 `404`（`error: "没有这个群"`）。

#### `POST /api/threads/:id/join`

任何登录用户可调，**幂等**：已经在群里返回 `joined: false`，不算失败。

```jsonc
{ "ok": true, "joined": true, "thread": { ... } }
```

#### `GET /api/threads/:id/members`

成员可看。非成员 `403`（`code: "not_member"`）。

```jsonc
{
  "ok": true,
  "ownerId": "u_23ff754b1af1ac0f",
  "canManage": true,     // 我是群主，能指定管理员
  "canRename": true,     // 我能改群名（系统管理员或群管理员）
  "members": [
    { "userId": "u_23ff754b1af1ac0f", "nickname": "产品阿宝", "role": "owner", "joinedAt": 1730000000000, "isBot": false },
    { "userId": "u_bot", "nickname": "AI员工", "role": "admin", "joinedAt": 1730000000000, "isBot": true }
  ]
}
```

#### `PATCH /api/threads/:id`

改群名。系统管理员或群管理员可改；成员也可，按后端判定。

```jsonc
{ "name": "登录体验" }
```

群名去空白后不能为空、不超过 40 字。成功返回 `{ ok: true, thread }`；
没权限返回 `403`（`error: "只有群管理员能改群名"`）。

#### `POST /api/threads/:id/members/:userId/role`

只有群主能调。`role` 只能是 `admin` 或 `member`。

```jsonc
{ "role": "admin" }
```

群主不能改自己的角色（`"群主不能改自己的角色"`），机器人不能改（`"机器人账号自动就是群管理员"`）。
成功返回最新的 `{ ok: true, members }`。

### `GET /api/threads/:id/artifacts/:token`

下载产物。需要登录。`token` 来自 `image`/`file` 消息里的 `url`。

返回文件本体，`content-disposition: attachment`。中文文件名同时给
ASCII 兜底和 RFC 5987 的 UTF-8 形式，避免部分客户端乱码。

产物文件是**复制**进 `.state/artifacts/<thread>/` 的，不是按记录的路径原样读——
公网 API 上的任意文件读取等于把整台机器交出去。单文件上限 50MB。

## 引擎通道

IM（`src/im.js`）和需求引擎（`src/engine.js`）分开部署时，两边只通过这一组接口对话。引擎是客户端：它主动连 IM，用长轮询拿事件、POST 回写消息和阶段。

鉴权用引擎密钥：IM 第一次启动时生成（`.state/engine-token`，也会打印一次），引擎侧写在配置的 `im.token` 里。请求头 `authorization: Bearer <密钥>`，错了返回 `401`。没配 `api.engineToken` 且没生成过密钥时，整组接口返回 `503`（`error` 里带「engineToken」）。

| 接口 | 谁调 | 说明 |
| --- | --- | --- |
| `GET /api/engine/inbox?after=&wait=` | 引擎 | 长轮询事件；`after` 是已拿到的最大 `seq`，`wait` 最多挂 30 秒 |
| `GET /api/engine/status` | App（**不鉴权**） | `{ online, botName, lastPollAt }`；`online` 为 `null` 表示从没连上过（纯聊天部署不提示），`false` 是连过又掉线（70 秒没轮询） |
| `POST /api/engine/messages` | 引擎 | 往群里发一条消息（文本/图片/文件/阶段/决策） |
| `POST /api/engine/groups/:id` | 引擎 | 上报需求阶段，只认白名单字段 |
| `GET /api/engine/can?action=&userId=` | 引擎 | 问「这个人能不能做这个动作」，答 `{ ok, role, roleLabel }` |

事件是一条 JSON，`type` 为 `start`（@ 了需求 bot、要开需求）或 `message`（需求群里接着说的话）：

```jsonc
{ "seq": 12, "at": 1730000000000, "type": "start",
  "groupId": "t1a2b3c4d5e6", "text": "首页加个欢迎弹窗",
  "mentions": ["u_bot"], "user": { "userId": "...", "nickname": "产品阿宝" } }
```

- 事件**落盘**在 `.state/engine/events.jsonl`：引擎断网或重启期间用户 @ 的不能静默消失，连上来按游标补。
- 引擎回写消息时，图片/文件走 base64 内联（`payload.data`），因为引擎那台机器的路径 IM 根本读不到；单条上限 20MB，超了退化成一句文本。
- 阶段上报只认 `reqId`/`reqName`/`stage`/`stageStatus`/`running`/`waitingLabel`/`featureBranch`：群名、模式、成员归 IM 管，引擎写了也不生效——两边都以为自己能改同一个字段，迟早打架。
- 引擎问权限失败（IM 暂时连不上）时**按没权限处理**：宁可拒一次，也不要因为连不上就放行。

IM 侧还有个细节：引擎离线时用户 @ 了它，会先回一句「需求引擎现在没连上。这条我先记下了，它连上之后会接着处理。」——然后照样把事件写进游标队列。

## 账号管理

### `GET /api/users`

只有 admin 能调。返回用户列表，**不含** `salt` 和 `passwordHash`。

### `POST /api/users/:id/role`

```jsonc
{ "role": "admin" }
```

`role` 只能是 `admin` 或 `member`。最后一个管理员不能降级（返回 `400`）。

### `POST /api/users/:id/disabled`

```jsonc
{ "disabled": true }
```

停用后立刻无法认证，手上 token 立即失效。最后一个管理员不能停用。

### `POST /api/users/:id/password`

```jsonc
{ "password": "newpass123" }
```

管理员替人重置密码（这就是"没有找回密码"的替代方案）。
