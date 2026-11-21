# 开发与测试

> 返回 [README](../README.md)

零依赖，测试脚本都是独立的 Node 程序——没有测试框架，也没有 `npm test`，直接跑就行。全部从**仓库根目录**执行。

## 会消耗 token 的两个

```bash
node test/full.js             # 全链路：从 App API 建群 → @AI员工 提需求 → 跑 dsh → 在消息流里收到回复
node test/queue-rerun.js      # 回合进行中插话，结束后必须补跑
```

`test/full.js` 的行为是**真把 `src/index.js` 当进程跑起来**，不是单元测试级别的模拟。

## 不消耗 token 的集成测试

```bash
node test/full.js --no-llm    # 起真实 bridge 进程，验证握手与路由
node test/panel-api.js        # 面板全部 HTTP 接口：分层、body 传参、错误码
node test/app-api.js          # App API：注册登录、权限、消息顺序、@ 与普通聊天
node test/engine-channel.js   # IM/引擎拆分：路由三态、事件游标、引擎通道鉴权与白名单
node test/transport.js        # 传输层：文本/图片/文件落库、失败不抛、跨会话不串
node test/messages.js         # 消息 JSONL：seq 递增、增量窗口、坏行容错
```

`test/full.js` 与 `test/queue-rerun.js` 都通过 `test/helpers/bridge.js` 起真进程、
走真实 HTTP API 驱动。`--no-llm` 用一个不存在的 `dshBin`，验证 spawn 失败时
进程活着且把原因播报进消息流——「界面上没反应」是这套系统最难查的故障。


## 代码结构

```
src/
  index.js          单机入口：编排层 + 面板 API + App API 一起起（IM 和引擎在一个进程里）
  im.js             只跑 IM：账号、群、消息、产物、App API、引擎通道（不需要模型凭证和仓库）
  engine.js         只跑需求引擎：长轮询 IM 拿事件、跑流程、回写消息和阶段
  flow-bridge.js    消息入口 + 播报 + feature 分支 + 合并
  im/
    router.js       「这句算聊天还是提需求」：@ 判据、去 @、模式切换
    events.js       引擎事件队列：落盘、游标、长轮询
  account/          账号：auth.js（scrypt + HS256 token）、store.js（用户表）
  api/              server.js（路由）、threads.js（thread ↔ 编排层接线）、engine.js（引擎通道）、http-util.js
  store/            消息 JSONL 落库、产物文件
  transport/        transport.js（本地落库）、http.js（发到 IM 的 HTTP 客户端）
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
  config.js  state.js  runner.js  commands.js  doctor.js
skills/             按阶段拆的角色卡，每回合只加载一张
app/                Flutter 客户端（群列表 / 群详情 / 登录），见 app/README.md
test/               独立测试脚本，没有框架
```

依赖方向是单向的：`index` → `flow-bridge` → `flow/*` → `infra/`。`flow/*` 不 import `ui/`
和 `transport/`，副作用全部由 `flow-bridge` 注入，所以状态机可以纯函数测试。

三个入口，同一套 `api/` 与 `store/`：

| 入口 | 装了什么 | 什么时候用 |
| --- | --- | --- |
| `src/index.js` | 编排层 + 面板 + App API | 单机，一台机器什么都干 |
| `src/im.js` | 账号/群/消息/产物 + App API + 引擎通道 | 只当 IM 用（拆开部署的 IM 那台） |
| `src/engine.js` | 编排层 + HTTP transport | 只跑需求（拆开部署的引擎那台） |

拆分的关键约定：`src/api/threads.js` 不再自己调 `flowBridge`，而是把「要不要交给引擎」
算成 `routeMessage()` 的结果，交给注入的 `dispatch`。单机时 `dispatch` 直接问 state machine；
拆开时它在 IM 侧变成 `EngineEvents.append`。这样同一个 `threads.js` 两边都能用。

会话标识这个参数在代码里仍叫 `groupId`，文件名仍是 `.state/group-<id>.json`。
这是 QQ 时代留下的命名，现在装的是 App 的 threadId：改名要动上百处、跨十几个
文件、零行为收益，所以**留名改语义**。判据只有一处——`src/api/threads.js` 的
`isAppThread()`（`t` 开头且非纯数字），用来把老数据里 `group-<群号>.json` 挡在
App 列表之外。

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
- 一个实例服务一个项目目录；要跑多个产品线，起多个实例（各自的 `api.port` 错开）

## Flutter App

`app/` 是需求 App 的 Flutter 客户端，独立于 Node 进程，通过 `api.enabled`
暴露的 `/api/*` 通话。它有自己的工具链和测试：

```bash
export PATH="$HOME/flutter/bin:$PATH"    # 本机 Flutter 不在 PATH 里
cd app
flutter analyze                          # 必须零 issue
flutter test                             # 单元测试，不需要后端

# 打真后端验契约（后端要在跑）
dart run tool/smoke.dart http://127.0.0.1:7881 用户名 密码
```

`tool/smoke.dart` 故意放在 `test/` 外面：它要求后端进程在跑，放进
`flutter test` 会让没有后端的机器上随机变红。带普通成员账号跑也能过
——脚本会先看 `/api/auth/me` 的 `perms`，没有 `startRequirement` 就
改验「建群被拒」，没有 `confirm` 就验「点通过被拒且文案可展示」。

App 侧的三条测试各管一摊，不重叠：

| 文件 | 管什么 |
| --- | --- |
| `app/test/api_test.dart` | 用 `MockClient` 测请求怎么拼、错误怎么映射 |
| `app/test/auth_test.dart` | 会话状态机：没地址/没 token/退出登录不留脏状态 |
| `app/tool/smoke.dart` | 后端到底认不认——打真端口 |

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
| `badge.js` | 面板徽章判断：会话状态 `waiting` ≠ 阶段完成 |
| `commands.js` | 指令解析：斜杠形式、大小写、参数切分、未知指令 |
| `config.js` | 配置加载：老配置兼容、已删的 QQ 段落能识别出来但不报错 |
| `messages.js` | 文案模板的渲染、校验、自定义覆盖 |
| `queue.js` | 排队消息的持久化 |
| `settings.js` | 文案模板渲染与校验（占位符、长度、未知 key、覆盖优先级） |
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


## 测试脚手架

`test/helpers/bridge.js` 负责起一个真 bridge 进程、等 App API 就绪、
用 HTTP API 驱动它。`full.js` 和 `queue-rerun.js` 都用它，所以它们测的是
「用户真的在 App 里点了那个按钮」这条路径，不是内部函数的单测。

两个约定：

- 临时目录用 `mkdtempSync`，配置里显式传 `stateDir`——否则测试会写进仓库自己的
  `.state/`，把真实的用户表和需求进度污染掉
- `api.port` 写 `0` 让内核分配端口，从启动日志里正则捞出来，避免撞上本机在跑的那个
