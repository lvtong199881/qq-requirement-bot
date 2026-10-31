# 配置说明

> 返回 [README](../README.md)

全部配置都在仓库根目录的 `bot.config.json` 里，首次从 `bot.config.example.json` 复制（见[安装指南](INSTALL.md)第 4 步）。

**群号不用填。** bot 连上 NapCat 后会自己调 `get_group_list` 报出它所在的群，你把它拉进哪个群，它就在哪个群工作。

```jsonc
{
  // 需求要落到哪些仓库。单仓库写一项即可；给了 url 时 bot 会自己 clone。
  "repos": [
    { "id": "app", "name": "Instanto", "path": "~/Documents/ChatGPT/Instanto", "platform": "harmony" }
  ],
  "dshBin": "dsh",
  "profile": "qqbot",

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
    "idleMinutes": 10                               // 静默多久报一次「当前正在 XX 阶段」
  },

  // 回传哪些文件由 flow 里的阶段声明决定，每阶段只发它自己声明的那份产物
  "upload": { "enabled": true, "maxFiles": 8, "maxFileMB": 20 },

  // 分阶段回合超时（分钟）。开发/测试/验收要跑构建、装包、逐条核对，给足时间；
  // 其余阶段主要是读写文档，30 分钟够。面板「设置 → 阶段超时」可改，只支持 10/15/30/60 四档。
  "stageTimeouts": { "default": 30, "dev": 60, "test": 60, "acceptance": 60 },
  "turnTimeoutMs": 1800000                        // 兼容旧配置：没有 stageTimeouts 时当作默认值
}
```

## 阶段超时

`stageTimeouts` 按阶段给回合上限（分钟），四个键：

| 键 | 管哪些阶段 | 默认 |
| --- | --- | --- |
| `default` | 需求澄清、需求定稿、设计、技术方案、代码评审、合并 | 30 |
| `dev` | 开发（含返工修正） | 60 |
| `test` | 测试 | 60 |
| `acceptance` | 验收 | 60 |

面板「设置 → 阶段超时」提供 `10 / 15 / 30 / 60` 四档，保存后立即热更新，不用重启。
超出四档的值面板会拒绝——防手滑改成 3 分钟把回合切碎。

超时不是「失败重试」，是**直接中断这一回合**。中断后该群状态停在 `running`，
发一句「继续」会从当前阶段重跑（产物和分支都在，不会重头来）。

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

**关于 `repos`**：`id` 是内部标识（路径按它派生，建了就别改）；`name` 是给人看的；`path` 和 `url` 二选一，给了 `url` 就由 bot 克隆到 `checkoutRoot`。`platform` 决定用哪套工具链（`harmony` / `android` / `ios`）。

## 编排

流程由 bridge 的状态机驱动（`src/flow.js` 的 `CHECKPOINTS` 表）：当前阶段、返工次数、
在等谁回答都由代码决定，不解析任何文本。每个阶段是一个独立回合，只加载
`skills/<角色>/SKILL.md` 那一份角色卡。

阶段顺序：需求澄清 → 需求定稿 → 设计 → 技术方案 → 开发 → 代码评审 → 测试 → 验收 → 合并 → 收尾。

`approval: "manual"` 时，每个阶段产出后停下等你回「通过」或「打回」。
开发阶段在 `feature/<需求标识>` 分支上进行，验收通过后由开发回合合并回主分支。
