# qq-requirement-bot

把 `requirement-spec` skill 接到 QQ 群：在群里 @产品同学 说一句需求，它按「产品需求 → 设计 → 技术方案 → 开发 → 代码评审 → 测试 → 验收」全流程自动跑，各阶段进度和产物自动同步回群里。

```
你    @产品同学  Instanto 首页加个欢迎弹窗，手动批准
产品同学  收到，开始处理。
         需要澄清 3 点：1. 弹窗出现时机？2. 是否记住关闭状态？3. 文案定稿了吗？
         等你回复：需求澄清
你    @产品同学  1. 首次启动 2. 记住 3. 用这句「欢迎回来」
产品同学  需求卡片和 PRD 已出，路径 docs/requirements/welcome-modal/PRD.md
         [群文件] welcome-modal__PRD.md
         等你回复：PRD 确认
```

## 它怎么工作

```
QQ 群 ──▶ NapCat（OneBot 11）──▶ bridge ──▶ dsh --profile qqbot --json
                                    ▲                    │
                                    └── NDJSON 事件流 ◀───┘
```

bridge 是唯一的自研代码，只做四件事：**收 @ 消息、起回合、转发进度、回传产物**。需求流程本身完全交给 requirement-spec，一行都不改。

关键设计：

- **一个群 = 一个 DSH 会话**。续跑带同一个 `--session-id`，上下文不丢。
- **闸门靠文本标记**。headless 没有交互式提问工具，所以让 agent 在需要用户回话时输出 `[[WAITING]]<说明>` 然后结束回合，bridge 收到就停下等下次 @。
- **单群串行**。同一群同一时刻只跑一个回合，避免两个回合抢写同一份技术方案；运行中插话会排队。
- **零依赖**。Node 22+ 自带 `WebSocket` 和 `fetch`，`npm install` 都不用跑。

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| Node ≥ 22 | 需要内置 WebSocket |
| `dsh` 在 PATH | `dsh --version` 能跑 |
| DEEPSEEK_API_KEY | 检查顺序：环境变量 → `~/.dsh/.credentials.yaml` |
| NapCat | 一个 QQ 号，开启**正向 WebSocket**，记下地址和 token |
| requirement-spec skill | 装在 `~/.agents/skills/requirement-spec` 即可自动发现 |

## 安装

```bash
cd ~/Documents/ChatGPT/qq-requirement-bot

# 1. 建 qqbot profile（从 headless 派生，仓库里已有模板）
cp -R profiles/qqbot ~/.dsh/profiles/qqbot

# 2. 配置
cp bot.config.example.json bot.config.json
$EDITOR bot.config.json        # 只需要改 projectDir；群号不用填

# 3. 自检
node src/doctor.js             # 配置 / 密钥 / skill / dsh / OneBot 连通性
node src/doctor.js --turn      # 额外真跑一个回合（消耗 token）

# 4. 启动
node src/index.js
```

## 配置说明

**群号不用填。** bot 连上 NapCat 后会自己调 `get_group_list` 报出它所在的群，你把它拉进哪个群，它就在哪个群工作。

```jsonc
{
  "projectDir": "~/Documents/ChatGPT/Instanto",  // 需求默认落地的项目
  "skillDir": "",                                  // 留空 = 自动探测（推荐）
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
    "idleMinutes": 10                              // 静默多久报一次「正在XX阶段，已等待X分钟」
  },

  "upload": { "enabled": true, "maxFiles": 8, "maxFileMB": 20 },
  "turnTimeoutMs": 2700000                        // 单回合超时（默认 45 分钟）
}
```

### 群策略

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

## 群里的指令

bot 只处理**群消息**，私聊不响应。斜杠指令用于极端情况下直接操作需求，不用靠自然语言猜。

| 指令 | 谁能用 | 作用 |
| --- | --- | --- |
| `/help` | 已授权成员 | 列出所有可用指令 + 当前状态 |
| `/resume` | 已授权成员 | 继续推进当前需求 |
| `/stop` | 已授权成员 | 停止当前正在跑的任务 |
| `/release` | **群主 / 白名单 / superAdmin** | 释放当前会话与进程（需回复「确认」二次确认） |

**权限模型**：能驱动 bot 的只有三类人，其他成员 @ 它会被**静默忽略**——不回任何话，
连「你没权限」都不说（避免刷屏和误触发）。

| 身份 | 生效范围 | 从哪来 |
| --- | --- | --- |
| `superAdmin` | 任意群 | `bot.config.json`，面板不允许改 |
| 群主 / 群管理员 | 仅本群 | OneBot `get_group_member_info` 判定，按群缓存 5 分钟 |
| `adminUsers` 白名单 | 任意群 | 面板或配置文件，额外放行 |

这里的「任意群」只是突破**人**的限制，不突破**群**的限制：群本身若被
`excludeGroups` 排除、或落在 `groupPolicy.mode=deny` 下，superAdmin 也照样不服务。

`/release` 比「能驱动 bot」再严一档：**群管理员也不能执行**，只认群主、`adminUsers`
和 `superAdmin`。被拒时会明说权限不够。

`adminUsers` 通常不用配（它同时是 `/release` 的放行名单）：

```json
"adminUsers": ["10001"]
```

后续加危险操作（清库、改配置）在新指令上标 `scope: 'admin'` 即可，分发逻辑不用动。

也可以直接说人话，效果一样：

| 说法 | 行为 |
| --- | --- |
| `继续` / `接着跑` / `接着来` / `go` | 同上 `/resume` |
| `停` / `停止` / `中断` / `停一下` / `取消` | 同上 `/stop` |
| `通过` / `好的` / `可以` / `同意` / `批准` / `ok` / `lgtm` | 批准当前阶段，进入下一阶段 |
| `打回 主按钮改成蓝色` | 打回当前阶段，**后面跟的文字就是修改意见** |
| `打回` / `不行` / `不对` / `有问题` / `重做` | 先追问「请提供修改意见」，等你补充才动 |
| `新需求 <描述>` / `重开` / `新任务` | 结束当前需求，开新的 |
| `帮助` / `help` / `?` / `怎么用` | 回一段用法说明（不是指令表，指令表用 `/help`） |
| `本群` / `群信息` / `状态` | 回群号、群名、绑定需求、当前阶段、项目目录 |
| 只说 `@产品同学`（无内容） | 回一句当前阶段状态；全新群会补一句怎么用 |

**打回是两段式**：只发「打回」不会立刻动工，bot 会问你要改什么；你也可以一次说完
`打回 xxx`，省掉这一轮问答。

### 群消息只有四类

1. 用户发消息后的回执：`当前XX阶段中，已进行 X小时X分钟X秒`
2. 阶段播报：`XX阶段已开始` / `XX阶段已完成`（附产物名）
3. 心跳：`当前XX阶段中，已进行 X...`（默认 5 分钟）
4. 异常：`XX阶段异常，请联系 bot 管理员，异常原因如下：…`

agent 的工作过程不进群。**唯一例外**：回合以「等用户拍板」结束时，它会用
`[[ASK]]` 标记把要判断的内容写出来，bridge 把这部分拼进阶段通知：

```
[[WAITING]]等你定这两项
[[ASK]]
1）系统大字体没生效（中）
- A（推荐）记为已知偏差，本需求不改
- B 本需求内就支持
```

群里收到的是阶段播报 + ASK 段（agent 没写 ASK 时退回整段答复兜底）。

## 管理面板

常驻进程，聚合所有正在运行的 bridge 实例，看状态、下指令。

```bash
./start-panel.sh              # 默认 http://127.0.0.1:7879/console
./start-panel.sh 8899         # 换端口
```

左侧菜单 + 右侧内容区。菜单两项：

**需求大盘**（默认）——每 3 秒轮询，列表展示 PID、需求名、QQ 群名、发起人、
当前阶段状态徽章，每行末尾 `⋯` 菜单提供 **终止 / 重启 / 详细信息**。
切到别的菜单会**自动停掉轮询**，切回来自动恢复。

**设置** —— 两项：

- **指令白名单**（可编辑）：填 QQ 号，中英文逗号均可分隔，保存时统一解析、校验、
  去重后写回 `bot.config.json`，并通知所有实例热更新（不用重启）。空值/多个逗号/
  换行都容忍；非法值（非数字、位数不对）会明确报错并拒绝保存。
- **群消息文案**（可编辑）：bot 在群里说的话，共 17 条，按「回执 / 阶段播报 /
  心跳 / 异常 / 交互提示」分组。每条独立编辑、独立恢复默认，只列自己可用的变量：
  `{{stage}}` `{{duration}}` `{{stageDone}}` `{{stageStarted}}` `{{reason}}`
  `{{content}}` `{{artifacts}}` `{{target}}` 等。校验拦：空模板、未知占位符、
  超过 2000 字符。留空保存 = 该条回默认。
- **超级管理员**（只读）：不受群角色与白名单限制，任何群都能驱动 bot——但突破的是
  「人」的限制，群本身若被 `excludeGroups` 排除或 `groupPolicy.mode=deny` 关闭，仍不服务。
  只能在 `bot.config.json` 的 `superAdmin` 字段里修改——面板不提供编辑入口，
  避免把自己锁在门外。

详细信息弹窗会显示该进程的完整状态：群 ID、当前模型、端口、发起时间、阶段进度、
当前回合（子进程是否存活、已运行多久）、最近 200 条日志。

### 架构

```
bridge（每个实例）
├── .instances/<pid>.json   启动时注册，退出时删除——面板靠它发现实例
└── 127.0.0.1:7878          /api/status、/api/logs、/api/groups/:id/{stop,restart}

panel（一个进程）
├── 扫描 .instances/        发现所有实例
├── 逐个拉 /api/status      聚合成一份数据
└── 127.0.0.1:7879          /console 页面 + 转发操作到对应实例
```

面板与 bridge 分离：bridge 崩了面板还活着，能告诉你它崩了。

### API

| 接口 | 说明 |
| --- | --- |
| `GET /api/status` | 本实例完整状态（bridge） |
| `GET /api/logs?n=200` | 最近日志（bridge） |
| `POST /api/groups/:id/stop` | 终止该群当前任务 |
| `POST /api/groups/:id/restart` | 重启该群任务（先掐断，再用「继续」骨架重跑） |
| `GET /api/instances` | 聚合所有实例（panel） |

写操作需要 `panel.token` 非空时携带 `x-panel-token`；留空则只依赖「仅监听 127.0.0.1」。

### 日志

按天落盘到 `.logs/bridge-YYYY-MM-DD.log`，同时保留内存中最近 500 条供面板读取。

## 测试

```bash
node test/e2e.js              # 单元 + OneBot 收发（不调 LLM）
node test/full.js --no-llm    # 起真实 bridge 进程，验证握手与路由
node test/full.js             # 全链路：注入群消息 → 跑 dsh → 收回复（消耗 token）
```

`test/mock-onebot.js` 是一个手写的极简 OneBot 服务端（自带 WS 帧编解码），不需要真的连 QQ 就能测。

## 已知限制

1. **单 QQ 号只能有一个昵称和一个头像**。所以本方案是「一个 bot + 文字区分阶段」，做不到 5 个不同头像的角色 bot。要真多号需要多个 QQ 号 + 多个 NapCat 实例，且风控敞口成倍增加。
2. **NapCat 是非官方协议端**，有封号风险。请用小号，并保持 `maxMessagesPerMinute` 不要调高。
3. **headless 没有 `ask_user_question`**。所有提问都是纯文本 + `[[WAITING]]` 停下，靠下一次 @ 回答。这是 headless 任务模型的限制，不是实现偷懒。
4. **同一项目目录只能绑一个群**。两个群绑同一目录会并发写坏 `技术方案.md`。
5. **回合之间进程重启**。shell 环境、临时变量不跨回合；流程状态靠 `docs/requirements/<需求标识>/编排记录.md` 和 `技术方案.md` 的开发内容表续跑，这本来就是 requirement-spec 的设计。

## 排错

| 现象 | 排查 |
| --- | --- |
| 启动了但群里没反应 | `bot.qq` 和 `frame.self_id` 是否一致；消息是否真的 @ 了 bot |
| `连不上 ws://…` | NapCat 是否开了正向 WS；端口是否对；token 是否要填 |
| `MISSING_CREDENTIAL` | `export DEEPSEEK_API_KEY=...`，或在 DSH Web GUI 的 Models 页保存 |
| 回合跑完群里只有一句「这一轮结束了」 | agent 没输出 `[[WAITING]]`/`[[DONE]]`，看 `--verbose` 日志 |
| 回复被截断 | 调大 `limits.chunkChars`，或调 `maxChunksPerTurn` |
| 群文件没收到 | NapCat 的 `upload_group_file` 需要 bot 是群管理或群主 |

开 `verbose: true` 可以看到每个事件和 token 用量。
