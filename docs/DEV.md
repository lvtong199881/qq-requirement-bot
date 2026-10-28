# 开发与测试

> 返回 [README](../README.md)

零依赖，测试脚本都是独立的 Node 程序——没有测试框架，也没有 `npm test`，直接跑就行。全部从**仓库根目录**执行。

## 会消耗 token 的两个

```bash
node test/full.js             # 全链路：注入群消息 → 跑 dsh → 收回复
node test/queue-rerun.js      # 回合进行中插话，结束后必须补跑
```

`test/full.js` 的行为是**真把 `src/index.js` 当进程跑起来**，不是单元测试级别的模拟。

## 不消耗 token 的集成测试

```bash
node test/full.js --no-llm    # 起真实 bridge 进程，验证握手与路由
node test/resilience.js       # NapCat 没起来 / 中途断开时，bridge 必须活着并自愈
node test/panel-api.js        # 面板全部 HTTP 接口：分层、body 传参、错误码
```

## 代码结构

```
src/
  index.js          入口：连 OneBot、权限闸门、面板 API
  flow-bridge.js    消息入口 + 播报 + feature 分支 + 合并
  flow/
    flow.js         阶段定义与状态机（纯函数，不碰 fs）
    orchestrator.js 任务包组装、回执校验、产物核对
    flow-runner.js  连续推进循环
    board.js        编排记录渲染
  infra/
    git.js          git 操作（分支、合并、diff）
    repo.js         裸仓库与 worktree（每个需求一个工作区）
    lock.js         跨平台文件锁 + 计数信号量
  ui/               panel.js / server.js / messages.js / format.js
  transport/        onebot.js
  config.js  state.js  runner.js  commands.js  doctor.js
skills/             按阶段拆的角色卡，每回合只加载一张
test/               独立测试脚本，没有框架
```

依赖方向是单向的：`index` → `flow-bridge` → `flow/*` → `infra/`。`flow/*` 不 import `ui/`
和 `transport/`，副作用全部由 `flow-bridge` 注入，所以状态机可以纯函数测试。

## 仓库配置

只有一个入口：`repos` 数组。单仓库就写一项——不需要第二个配置项。

```json
{
  "repos": [
    { "id": "app", "path": "~/your-project", "primary": true },
    { "id": "ui-kit", "path": "~/ohos-ui-kit" }
  ]
}
```

- `primary` 标主仓库；不标就是第一个。只能有一个
- 代码里的 `config.projectDir` 是主仓库路径的派生值，不是独立配置
- 群级可以用 `"repo": "ui-kit"` 指向另一个已配置的仓库（不同群服务不同产品线），
  指向未配置的 id 会直接报错

## 三个进程

改造后是三个独立进程，各管一摊，通过 HTTP 调用：

```
模拟器服务 :7880   ← 设备发现、启停、租约；配置只在这里读
   ↑ HTTP
bridge    :7878    ← 编排；需要设备时向服务申请租约
panel     :7879    ← 面板；模拟器操作转发给服务，不自己实现

全链路日志：.logs/{emulator,bridge,panel}-stdout.log
```

**为什么模拟器要单独成服务**：设备是机器级资源，和「谁在跑需求」无关。多个
bridge 实例、面板、以后的别的工具都要用它；进程内 import 会把这些焊死，
而且设备租约必须集中管理——分散在各自进程里的锁无法判断「这台现在归谁」。

启动顺序无所谓，服务没起来时 bridge 会在需要设备的那一刻报明确错误。

## 鸿蒙工具链脱离 DevEco

`scripts/setup-ohos-toolchain.sh` 把 SDK / 模拟器 / hvigor 抽到独立目录
（约 6 GB，完整 DevEco 是 11 GB），IDE 本体不需要：

```bash
./scripts/setup-ohos-toolchain.sh              # 装到 ~/ohos-toolchain
./scripts/setup-ohos-toolchain.sh --link-sdk   # SDK 软链，省 5.5G
source ~/ohos-toolchain/env.sh
```

实测：编译 9 秒、单测 6 秒（比 DevEco 的 `hvigorw` 快，那个会卡 daemon）。
唯一仍依赖 DevEco 的是 SDK 本身——官方没有独立的 SDK 下载入口，只能从安装包里复制。

## 数据放在哪

团队化改造后，bot **不持有任何主工作区**，只有裸仓库和按需创建的 worktree：

```
~/.qq-bot/
  repo.git             裸仓库（~100 MB），只存对象和引用
  worktrees/<reqId>/   每个需求的代码工作区，dev 阶段才创建
  worktrees/_merge/    合并专用工作区，全局串行使用
  data/<reqId>/        需求文档（PRD、方案、报告），不进 git
```

| 阶段 | 文档写哪 | 代码改哪 |
| --- | --- | --- |
| 澄清 / 定稿 / 设计 / 技术方案 | `data/<reqId>/` | 不需要 |
| dev / review / test / acceptance | `data/<reqId>/` | `worktrees/<reqId>/` |
| merge | 归档进仓库 | `worktrees/_merge/` |

为什么不共用一个工作目录：两个需求同时在 dev 时，`git checkout` 会把别人的工作目录切走，
而且没有任何报错——代码就写到了错误的分支上。worktree 让每个需求独占一个目录。

合并成功后工作区、本地分支、文档目录都会回收（文档已经随合并提交进仓库）。

### 迁移旧数据

改造前需求文档在仓库内的 `docs/requirements/`。迁移脚本把进行中的需求搬到 `data/`：

```bash
node src/migrate.js            # 预演，只打印会做什么
node src/migrate.js --apply    # 真的执行（幂等，可重复跑）
```

## 纯逻辑单测

| 脚本 | 覆盖什么 |
| --- | --- |
| `badge.js` | 面板徽章判断：群状态 `waiting` ≠ 阶段完成 |
| `commands.js` | 指令解析、白名单、`/help` 文案 |
| `messages.js` | 文案模板的渲染、校验、自定义覆盖 |
| `queue.js` | 排队消息的持久化 |
| `settings.js` | 白名单输入解析、校验、边界 |
| `timeline.js` | 心跳 / 回执话术边界：别把「刚开始」播成「已进行 0 分钟」 |

## 编排（状态机驱动）

流程由 bridge 持有状态机推进，不解析任何文本。这几组测试全部不消耗 token：

| 脚本 | 覆盖什么 |
| --- | --- |
| `flow.js` | 阶段推进、评审闸门、返工计数、两种「等用户」语义 |
| `orchestrator.js` | 任务包组装、回执结构校验、产物核对（含 gitDiff 模式） |
| `flow-runner.js` | 连续推进循环：什么时候停、什么时候重试、何时换会话 |
| `flow-bridge.js` | 消息入口三态：新需求 / 回答 / 排队，以及卡住重试 |
| `board.js` | 编排记录渲染：阶段表格、停点、待决策，状态推导 |
| `git-branch.js` | feature 分支：从主分支拉、已存在则切过去、合并回主分支、冲突不自动解决 |

改流程逻辑时，先改 `src/flow/flow.js` 的 `CHECKPOINTS`，跑 `node test/flow.js`；
它挂了就别往下改，后面的循环都是按这张表走的。


## Mock OneBot

`test/mock-onebot.js` 是一个手写的极简 OneBot 服务端，自带 WS 帧编解码，**不需要真的连 QQ 就能测**。`full.js`、`resilience.js`、`queue-rerun.js` 都靠它造群消息和断线场景。
