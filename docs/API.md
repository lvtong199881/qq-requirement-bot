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
- **第一个注册的账号自动成为 admin**，否则新装机没人能批需求
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

App 首屏据此决定「显示注册还是只显示登录」。

```jsonc
{ "ok": true, "needsFirstAdmin": true }
```

`needsFirstAdmin` 为 `true` 时说明一个账号都没有，此时注册的那个人会成为管理员。

### `POST /api/auth/register`

```jsonc
{ "username": "阿宝", "password": "pass1234", "nickname": "产品阿宝" }
```

`nickname` 可省略，省略时用 username。成功：

```jsonc
{
  "ok": true,
  "token": "eyJhbGci...",
  "user": { "id": "...", "username": "阿宝", "role": "admin", "roleLabel": "系统管理员", ... },
  "notice": "你是第一个注册的，已自动成为系统管理员"
}
```

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

## 需求（thread）

App 里的「一条需求」在服务端就是一个 thread。它的 id 形如 `t1a2b3c4d5e6`，
在编排层里直接当作原来的 `groupId` 用——状态机、并发槽、worktree 池、
产物校验、git 操作全部不用改。

### `GET /api/threads`

需要登录。

```jsonc
{
  "ok": true,
  "threads": [
    {
      "threadId": "t1a2b3c4d5e6",
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
      "canAct": true
    }
  ]
}
```

- `needsMe` —— 该你拍板了（等价于 `stageStatus === "等你确认"`），列表页拿它做置顶和红点
- `lastSeq` —— 这条需求最后一条消息的序号，App 用它算未读
- `canAct` —— 当前用户能不能通过/打回（普通成员为 `false`）

### `POST /api/threads`

新建需求。需要 `startRequirement` 权限（只有 admin）。

```jsonc
{ "text": "给首页加个欢迎弹窗，新用户第一次打开时出现" }
```

成功返回 `{ ok: true, threadId, thread }`。

**这个接口立刻返回，不等回合跑完。** 一次需求要走需求→设计→方案→开发→测试→验收
好几个阶段，可能几十分钟，HTTP 请求等不起。拿到 `threadId` 后去轮询消息流看进展。

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

`role` 是 `user`（团队里的人说的）或 `bot`（产品同学说的）。

`kind` 与对应 `payload`：

| kind | payload | 说明 |
| --- | --- | --- |
| `text` | `{ text }` | 普通文本 |
| `image` | `{ url, name }` | 设计稿，`url` 可直接下载 |
| `file` | `{ url, name, size }` | 交付文件 |
| `stage` | `{ stage, status }` | 阶段变化，App 可渲染成进度卡片 |
| `decision` | `{ title, items }` | 待决策项 |

消息存成每 thread 一个 JSONL 文件（`.state/messages/<threadId>.jsonl`），
只追加不改写。`text` 超过 20000 字会被截断。

### `POST /api/threads/:id/messages`

说一句话。需要登录（任何角色都能发言）。

```jsonc
{ "text": "给新用户看，第一次打开的时候弹" }
```

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

### `GET /api/threads/:id/artifacts/:token`

下载产物。需要登录。`token` 来自 `image`/`file` 消息里的 `url`。

返回文件本体，`content-disposition: attachment`。中文文件名同时给
ASCII 兜底和 RFC 5987 的 UTF-8 形式，避免部分客户端乱码。

产物文件是**复制**进 `.state/artifacts/<thread>/` 的，不是按记录的路径原样读——
公网 API 上的任意文件读取等于把整台机器交出去。单文件上限 50MB。

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
