# 开发与测试

> 返回 [README](../README.md)

零依赖，测试脚本都是独立的 Node 程序——没有测试框架，也没有 `npm test`，直接跑就行。全部从**仓库根目录**执行。

## 会消耗 token 的两个

```bash
node test/e2e.js              # 端到端：mock OneBot + 真 dsh，走一遍「@ → 回合 → 回群」
node test/full.js             # 全链路：注入群消息 → 跑 dsh → 收回复
```

`test/full.js` 的行为是**真把 `src/index.js` 当进程跑起来**，不是单元测试级别的模拟。

## 不消耗 token 的集成测试

```bash
node test/e2e.js --no-llm     # 只测 OneBot 收发与路由，不起 dsh
node test/full.js --no-llm    # 起真实 bridge 进程，验证握手与路由
node test/resilience.js       # NapCat 没起来 / 中途断开时，bridge 必须活着并自愈
node test/panel-api.js        # 面板全部 HTTP 接口：分层、body 传参、错误码
```

## 纯逻辑单测

| 脚本 | 覆盖什么 |
| --- | --- |
| `ask.js` | `[[ASK]]` 标记：要用户拍板的内容单独承载，由 bridge 拼接 |
| `badge.js` | 面板徽章判断：群状态 `waiting` ≠ 阶段完成 |
| `broadcast.js` | 四类群消息的话术格式与触发逻辑 |
| `commands.js` | 指令解析、白名单、`/help` 文案、`/release` 二次确认 |
| `decision.js` | 决策内容：agent 给 JSON，bridge 渲染成文本 |
| `decision-retry.js` | 决策格式不合规时的自动重写流程 |
| `final-answer.js` | 等待确认时只发最终答复，过程文字不进群 |
| `messages.js` | 文案模板的渲染、校验、自定义覆盖 |
| `queue.js` | 排队消息的持久化 |
| `router.js` | 防走偏：分类、绑定、锚点、prompt 骨架生成 |
| `settings.js` | 白名单输入解析、校验、边界 |
| `stage.js` | 阶段逻辑：回执文案、播报计划、计时起点 |
| `stage-timing.js` | 阶段刚切换、回合未结束时不能沿用上一阶段的时间戳 |
| `timeline.js` | 心跳 / 回执话术边界：别把「刚开始」播成「已进行 0 分钟」 |
| `turn-payload.js` | 回合投喂内容的完整性 |

## v2 编排（状态机驱动）

流程由 bridge 持有状态机推进，不解析任何文本。这几组测试全部不消耗 token：

| 脚本 | 覆盖什么 |
| --- | --- |
| `flow.js` | 阶段推进、评审闸门、返工计数、两种「等用户」语义 |
| `orchestrator.js` | 任务包组装、回执结构校验、产物核对（含 gitDiff 模式） |
| `flow-runner.js` | 连续推进循环：什么时候停、什么时候重试、何时换会话 |
| `flow-bridge.js` | 消息入口三态：新需求 / 回答 / 排队，以及卡住重试 |
| `board.js` | 编排记录渲染：阶段表格、停点、待决策，状态推导 |
| `git-branch.js` | feature 分支：从主分支拉、已存在则切过去、合并回主分支、冲突不自动解决 |

改 v2 的流程逻辑时，先改 `src/flow.js` 的 `CHECKPOINTS`，跑 `node test/flow.js`；
它挂了就别往下改，后面的循环都是按这张表走的。


## Mock OneBot

`test/mock-onebot.js` 是一个手写的极简 OneBot 服务端，自带 WS 帧编解码，**不需要真的连 QQ 就能测**。`e2e.js`、`full.js`、`resilience.js` 都靠它造群消息和断线场景。
