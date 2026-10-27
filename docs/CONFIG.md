# 配置说明

> 返回 [README](../README.md)

全部配置都在仓库根目录的 `bot.config.json` 里，首次从 `bot.config.example.json` 复制（见[安装指南](INSTALL.md)第 5 步）。

**群号不用填。** bot 连上 NapCat 后会自己调 `get_group_list` 报出它所在的群，你把它拉进哪个群，它就在哪个群工作。

```jsonc
{
  "projectDir": "~/Documents/ChatGPT/Instanto",  // 需求默认落地的项目
  "skillDir": "",                                  // 留空 = 自动探测（推荐）
  "dshBin": "dsh",
  "profile": "qqbot",
  "orchestrator": "v1",                            // v1=旧版；v2=状态机驱动（见下文）

  "bot": { "qq": "", "name": "产品同学" },         // 群里显示的昵称

  "onebot": { "ws": "ws://127.0.0.1:3001", "token": "" },

  "groupPolicy": { "mode": "auto" },               // auto = 拉进哪个群就服务哪个群
  "approval": "manual",                            // manual = 每阶段等确认；auto = 自动推进

  "limits": {
    "maxMessagesPerMinute": 10,                    // 发送限流，防风控
    "chunkChars": 3000,                            // 超过才拆条；正常一条发完
    "maxChunksPerTurn": 4                          // 一回合最多拆几条
  },

  "heartbeat": {
    "enabled": true,                               // 静默心跳开关
    "idleMinutes": 5                                // 静默多久报一次「正在XX阶段，已等待X分钟」
  },

  // 回传哪些文件不由 patterns 决定：按 artifacts.js 的阶段白名单，每阶段只发一份产物
  "upload": { "enabled": true, "maxFiles": 8, "maxFileMB": 20 },
  "turnTimeoutMs": 2700000                        // 单回合超时（默认 45 分钟）
}
```

## 群策略

| mode | 行为 | 用在哪 |
| --- | --- | --- |
| `auto`（默认） | 任何拉进 bot 的群都服务，项目目录用顶层 `projectDir` | 日常用，最省事 |
| `allowlist` | 只服务 `groups` 里列出的群，可给每个群配不同项目目录 | 一个 bot 服务多个项目时 |
| `deny` | 全部拒绝 | 临时关闭 |

`auto` 模式下完全不需要写 `groups`。只有想「同一个人 bot 服务多个项目、不同群落不同目录」时才用 `allowlist`：

```jsonc
{
  "groupPolicy": { "mode": "allowlist" },
  "groups": [
    { "groupId": "111111", "projectDir": "~/Documents/ChatGPT/Instanto", "approval": "manual" },
    { "groupId": "222222", "projectDir": "~/Documents/ChatGPT/KuaiSao", "approval": "auto" }
  ]
}
```

**关于 `skillDir`**：默认留空。bridge 会依次探测 `$QQ_RS_SKILL_ROOT/requirement-spec`、`~/.agents/skills/requirement-spec`、`~/.dsh/skills/requirement-spec` 等位置，用 `SKILL.md` 里的 `name: requirement-spec` 校验是不是对的那份。换机器、多人共用、目录搬家都不用改配置。只有确实要指向特殊位置时才显式写。

## 编排实现：v1 / v2

| 值 | 流程谁控制 | 当前阶段从哪来 | 备注 |
| --- | --- | --- | --- |
| `v1`（默认） | agent 读整份 requirement-spec 自己推进 | 解析 `[[WAITING]]` 标记 + 编排记录表格 | 现网在跑 |
| `v2` | bridge 按 `src/flow.js` 的 checkpoint 表推进 | 状态机自己持有，不解析任何文本 | 新需求试跑 |

v2 下每个阶段的能力由 `skills/<角色>/SKILL.md` 提供，bridge 只负责顺序、输入清单、产物校验、返工和停点。
两套实现并存：群状态里的 `flow` 字段归 v2，`stage/finishedStages/...` 归 v1，互不影响。
验证完再删 v1，不用一次性替换。

