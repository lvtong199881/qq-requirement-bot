# API 参考

> 返回 [README](../README.md)

面板和 bridge 各有一个 HTTP 服务，都**只监听 127.0.0.1**。本文按进程分节：
先约定鉴权与错误格式，定义几个共享结构，再逐个接口列参数和响应字段。

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
| 400 | 缺参数、JSON 不合法、白名单格式不对、文案占位符未知、群里没有在跑的回合 |
| 404 | 详情里的 pid 已不在运行、未知路径 |
| 500 | 读写 `bot.config.json` 失败等 |

## 数据结构

### Group —— 一个群的状态

出现在 `/api/summary`、`/api/status`、`/api/board` 的行、`/api/board/detail` 里。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `groupId` | string | QQ 群号 |
| `groupName` | string \| null | 群名，来自 `get_group_info`，没拿到为 `null` |
| `reqId` | string \| null | 绑定的需求标识，如 `welcome-dialog` |
| `stage` | string \| null | 当前阶段名 |
| `stageStatus` | string | `进行中` / `已完成` / `未开始` |
| `status` | string | 回合状态（gate 状态） |
| `waitingLabel` | string | 在等什么；空串表示没在等 |
| `turn` | number | 该群已跑过的回合数 |
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
| `botNickname` | string \| null | QQ 真实昵称（和对外自称 `botName` 分开） |

### Config —— 该实例的配置快照

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `profile` | string | dsh profile 名，通常 `qqbot` |
| `botQQ` | string | bot 的 QQ 号 |
| `botName` | string | 对外自称（群里显示的名字） |
| `projectDir` | string | 需求落地的项目目录 |
| `groupPolicy` | string | `auto` / `allowlist` / `deny` |
| `model` | string \| null | 模型标识 |
| `heartbeatMinutes` | number | 心跳间隔 |
| `turnTimeoutMin` | number | 单回合超时 |

### OneBot —— 协议端连接

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | WebSocket 地址 |
| `connected` | boolean | 是否已连上 |
| `selfId` | string \| null | 登录的 QQ 号 |

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
  "onebot": { /* OneBot */ },
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
{
  "adminUsers": ["10001", "10002"],          // 可选
  "messageTemplates": { "ack": "收到" }       // 可选，空对象 = 全回默认
}
```

响应：`{ "ok": true }`

### `POST /api/groups/stop`

| body 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `groupId` | string | 是 | 要终止的群 |

终止该群当前回合（杀掉 dsh 子进程）。

```jsonc
// 成功
{ "ok": true, "message": "已终止当前回合" }
// 没在跑 → 400
{ "ok": false, "error": "该群当前没有在跑的回合" }
// 缺 groupId → 400
{ "ok": false, "error": "缺少 groupId" }
```

### `POST /api/groups/restart`

参数同 stop。先中断，等 300ms，再用「继续」骨架重起一轮（带需求锚点，
从编排记录接着跑，不丢 sessionId）。

响应：`{ "ok": true, "message": "已重启" }`

---

## panel（一个进程，7879）

### `GET /api/board`

需求大盘：后端已经把各实例的群摊平成行，前端拿到直接画表格。

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
  "alerts": 0,                 // 不可达或 OneBot 断开的实例数
  "at": 1793000000000
}
```

### `GET /api/board/detail?pid=&groupId=`

点「详细信息」时才拉。大盘某一行展开：一个群 + 它所在的进程。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pid` | number | 是 | bridge 进程号 |
| `groupId` | string | 否 | 不传则 `group` 为 `null` |

```jsonc
{
  "instance": { /* Instance */ },
  "config": { /* Config */ },
  "onebot": { /* OneBot */ },
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
  "adminUsers": ["10001"],
  "superAdmin": ["10002"],        // 只读，写会被拒绝
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
  "messageVars": { "stage": "阶段名，如「开发」" }   // 所有可用变量及说明
}
```

配置文件读失败时返回 `{ "ok": false, "error": "..." }`。

### `POST /api/settings/save`

保存配置 → 落盘 → 通知所有实例热更新。只传要改的字段，两个都不传会 400。

```jsonc
{ "adminUsers": ["10001", "10002"] }
{ "messageTemplates": { "ack": "收到，开始处理。" } }
```

响应 = 保存后的设置（同 `GET /api/settings`），外加每个实例的热更新结果：

```jsonc
{
  "ok": true,
  "adminUsers": ["10001", "10002"],
  "superAdmin": [],
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

### `POST /api/groups/stop` / `POST /api/groups/restart`

参数与响应和 bridge 的同名接口一致，区别是面板会**先找到持有该群的实例**再转发：

```jsonc
{ "groupId": "476230759" }
```

找不到任何实例服务这个群时返回 `{ "ok": false, "error": "没有实例在服务群 476230759" }`。
