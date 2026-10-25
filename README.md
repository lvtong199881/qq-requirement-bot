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
$EDITOR bot.config.json        # 填群号、项目目录

# 3. 自检
node src/doctor.js             # 配置 / 密钥 / skill / dsh / OneBot 连通性
node src/doctor.js --turn      # 额外真跑一个回合（消耗 token）

# 4. 启动
node src/index.js
```

## 配置说明

```jsonc
{
  "projectDir": "~/Documents/ChatGPT/Instanto",  // 需求默认落地的项目
  "skillDir": "",                                  // 留空 = 自动探测（推荐）
  "dshBin": "dsh",
  "profile": "qqbot",

  "bot": { "qq": "", "name": "产品同学" },         // 群里显示的昵称

  "onebot": { "ws": "ws://127.0.0.1:3001", "token": "" },

  "groups": [
    {
      "groupId": "群号",
      "projectDir": "可选，覆盖顶层 projectDir",
      "approval": "manual"                        // manual = 每阶段等确认；auto = 自动推进
    }
  ],

  "limits": {
    "maxMessagesPerMinute": 10,                    // 发送限流，防风控
    "chunkChars": 400,                             // 单条消息字数
    "maxChunksPerTurn": 12                         // 一回合最多发几条
  },

  "upload": { "enabled": true, "maxFiles": 8, "maxFileMB": 20 },
  "turnTimeoutMs": 2700000                        // 单回合超时（默认 45 分钟）
}
```

**关于 `skillDir`**：默认留空。bridge 会依次探测 `$QQ_RS_SKILL_ROOT/requirement-spec`、`~/.agents/skills/requirement-spec`、`~/.dsh/skills/requirement-spec` 等位置，用 `SKILL.md` 里的 `name: requirement-spec` 校验是不是对的那份。换机器、多人共用、目录搬家都不用改配置。只有确实要指向特殊位置时才显式写。

## 群里的指令

| 你说 | 效果 |
| --- | --- |
| `@产品同学 <需求描述>` | 开新需求，或续跑当前需求 |
| `@产品同学 通过` / 修改意见 | 闸门放行 / 打回重做 |
| `@产品同学 继续` | 上一轮没收敛时接着跑 |
| `@产品同学 停` | 打断当前回合 |
| `@产品同学 新需求` / `重开` | 清空上下文，下一条消息开新需求 |

产物自动回传：每回合结束后，`docs/requirements/**` 下新增或改动的 `.md` / `.png` / `.jpg` 会作为群文件上传。

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
