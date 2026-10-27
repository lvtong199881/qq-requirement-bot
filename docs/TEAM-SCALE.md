# 团队化改造技术方案

> 状态：待评审　|　目标版本：0.2.0　|　影响范围：编排主链路、权限、状态存储

## 1. 背景

### 定位变了

这个服务从「一个人用的小工具」变成「全团队共用的需求流水线」：

| 维度 | 之前 | 现在 |
| --- | --- | --- |
| 使用者 | 1 人 | 约 10 人 |
| 并发需求 | 通常 1 个 | 每人 N 个，最多约 100 个在推进 |
| 组织形态 | 一个需求一个群 | 不变，仍是一个需求一个群 |
| 部署 | 个人电脑 | 先本机，后续上服务器 |
| 面板 | 自己看 | 1～2 个系统管理员看 |

### 结论先说

**当前代码在「一个需求」下是安全的，在「两个需求同时跑」下会破坏数据。**

这不是性能问题，是正确性问题，必须先修。其余（权限、面板、可靠性）是协作与运维问题，可以排在后面。

---

## 2. 现状与问题

### 2.1 P0：所有需求共用同一个工作目录（数据破坏级）

`projectDir` 是全局配置：

```json
{ "projectDir": "~/Documents/ChatGPT/Instanto" }
```

每个群的需求都指向它。而 `dev` 阶段开始时执行的是**全局切换分支**：

```js
// flow-bridge.js — onCheckpointStart
if (cp.id === 'dev') {
  ensureFeatureBranch(st.projectDir, flow.reqId)   // → git checkout -b feature/<reqId>
}
```

两个群同时进入 `dev`（或其中任一回合同再切分支）时：

```
群 A 的 agent：正在写 entry/src/main/ets/view/WelcomeDialogView.ets
群 B 触发 dev：git checkout -b feature/<B>     ← 工作目录整体切走
群 A 继续写：文件落在 feature/<B> 分支上，或直接覆盖群 B 的改动
```

**没有任何报错**。程序照常运行、回执照常写、阶段照常推进，只是代码写到了错误的分支上。

同一项目下 `docs/requirements/` 也会被并发读写，虽然按 `reqId` 分了目录，但 `git add -A`、`git status` 这类操作看到的是**全部未提交改动**，会把别人的东西一起提交。

### 2.2 P1：权限粒度不匹配组织模型

现在的权限只有一个笼统的闸门：

```js
async function canOperate(groupId, userId) {
  if (config.superAdmin.includes(uid)) return { ok: true }        // 超管
  const role = await memberRole(groupId, uid)                     // owner/admin/member
  if (role === 'owner' || role === 'admin') return { ok: true }   // 群主或群管理员
  if (config.adminUsers.includes(uid)) return { ok: true }        // 系统管理员
  return { ok: false }
}
```

问题：

- **群管理员能发起需求**——按组织约定，发起只该由群主做
- **系统管理员没有显式建模**——它靠「白名单」混在同一个闸门里，无法表达「上帝权限」
- 所有动作共用一套判断，无法按动作区分

### 2.3 P1：没有并发控制

每个回合 spawn 一个 `dsh` 子进程。100 个需求同时推进时：

- 内存与 CPU 被 100 个 Node/dsh 进程打满
- API 账单不可控
- 鸿蒙构建（`hvigorw`）本身是重任务，并发编译会互相拖慢甚至超时

现在没有任何闸门，来多少跑多少。

### 2.4 P2：面板没有多需求视图

面板按「单需求」设计：一个群一张卡。100 个需求时需要知道——谁在跑、谁在排队、谁占着 worktree。

### 2.5 P2：可靠性缺口

- 进程重启会杀掉正在跑的 `dsh` 回合（未 `detached`）
- 状态写入非原子（进程在 `writeFileSync` 中途被杀会产生残缺 JSON）
- 面板端口硬编码，多实例会冲突

---

## 3. 目标

| # | 目标 | 验收方式 |
| --- | --- | --- |
| G1 | 多个需求并行开发，互不干扰 | 两个需求同时 dev，各自产物落在正确分支 |
| G2 | 权限符合组织模型 | 群管理员无法发起需求；系统管理员在任何群可操作 |
| G3 | 并发可控 | 100 个需求在推进时，同时执行的回合数不超过配置上限 |
| G4 | 队列可见 | 面板显示排队需求、worktree 占用、执行槽占用 |
| G5 | 重启不中断回合 | 重启期间正在跑的回合继续完成，重启后被捡回 |
| G6 | bot 不持有主工作区 | `repo.git` 是 bare 仓库，任何时刻没有「主工作区」可被并发 checkout |

**不在本期目标**：跨机器部署、多实例 HA、任务队列重投。

---

## 4. 方案设计

### 4.1 仓库与工作区：bare 仓库 + 按需 worktree

#### 结论：bot 完全不持有一个「主工作区」

评审时发现前一版方案有个硬伤：只要存在「主工作区」，它就会被并发使用——一个需求在里面写文档、另一个需求的合并在里面 `checkout`，两者互相踩，且**不会报错**。

所以彻底拿掉主工作区，改用 **bare 仓库**：

```
~/.qq-bot/repo.git                  ← bare 仓库：只有 git 对象，没有任何工作区文件
~/.qq-bot/worktrees/<reqId>/        ← 每个需求一个 worktree（dev 阶段才创建）
~/.qq-bot/worktrees/_merge/         ← 唯一的合并工作区，全局串行使用
~/.qq-bot/data/<reqId>/             ← 需求文档，不进 git
```

`repo.git` 100 MB 左右，只存对象和引用。**没有工作区就没有 `checkout`**，也就不存在「两个需求抢同一个工作目录」。

#### 初始化命令（不能直接用 `git clone --bare`）

实测有三个坑，全都会让后续命令跑挂：

| 用 `clone --bare` 会出现的问题 |
| --- |
| `origin` 指向**源仓库的本地路径**，不是 GitHub → bot 会同步到未推送的提交 |
| 没有 `refs/remotes/origin/*`（refspec 直接映射到 `refs/heads/*`）→ `origin/main` 不存在 |
| `HEAD` 指向 clone 时的那个分支，不一定是主分支 → 主分支检测出错 |

正确做法：

```bash
git init --bare ~/.qq-bot/repo.git
cd ~/.qq-bot/repo.git
git remote add origin <远端地址>                                    # 显式指向远端
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git config remote.origin.prune true
git fetch origin
git symbolic-ref HEAD refs/heads/<主分支>                            # 显式钉住主分支
```

验证标准：`git rev-parse --verify origin/<主分支>` 能返回提交、`git symbolic-ref HEAD` 指向主分支。

#### 为什么这样可以

git 的 `worktree` 机制本身就允许一个仓库对应多个独立工作区：

```bash
git --git-dir=~/.qq-bot/repo.git worktree add \
  ~/.qq-bot/worktrees/<reqId> -b feature/<reqId> origin/main
```

每个 worktree 有自己独立的 `HEAD`、索引、工作区文件，但共享同一份对象库。所以：

- 群 A 的 agent 在 `worktrees/a1/` 里切分支、改代码、提交，**不影响任何其他人**
- 群 B 同时在 `worktrees/b2/` 里做同样的事
- `.git` 对象只存一份

#### worktree 里的 `.git` 是一个文件

```bash
$ cat ~/.qq-bot/worktrees/a1/.git
gitdir: /Users/xxx/.qq-bot/repo.git/worktrees/a1
```

不是目录，是一行指向裸仓库的指针。`git status`/`git commit` 等命令照常工作，但 agent 如果在那里
执行 `git clone`、`git init` 会得到奇怪的结果。skill 里要提一句：**在 worktree 里只用常规 git 命令，
不要重新初始化仓库**。

#### 需求文档放在 git 之外

所有阶段的产物（PRD、设计说明、技术方案、评审报告、测试报告、验收文档）写到：

```
~/.qq-bot/data/<reqId>/
```

**不进 git 工作区**。这样 100 个需求同时做需求澄清、设计、技术方案时，它们只是在各自的目录里写文件，git 完全不参与，零冲突。

代价是这些文档在需求进行期间没有版本历史。可以接受——需求文档的价值在归档和可追溯，而归档发生在合并那一刻（见下）。

#### 合并阶段：先落文档，再合代码

`merge` 回合在一个**全局唯一**的合并 worktree 里执行，并用 `flock` 保证串行：

```bash
flock ~/.qq-bot/merge.lock -- bash -c '
  cd ~/.qq-bot/worktrees/_merge
  git merge --abort 2>/dev/null || true     # 清理上次中断留下的合并状态
  git reset --hard origin/<主分支>
  git clean -fd                              # 清掉未跟踪残留
  git fetch origin
  git reset --hard origin/<主分支>          # 追平远端
  rsync -a --delete ~/.qq-bot/data/<reqId>/ docs/requirements/<reqId>/   # 幂等同步
  git add docs/requirements/<reqId>
  git commit -m "docs(<reqId>): 需求文档归档"
  git merge --no-ff feature/<reqId>         # 再合代码
  git push origin <主分支>
'
```

顺序很重要：**先提交文档，再合并代码**。这样如果代码合并出冲突，文档已经安全落库，不会因为一次失败重试而丢失。

**合并阶段不跑编译。** 编译验证在 `dev` 阶段已经做过（在 feature 分支上），合并只是把已验证的提交搬过去。
好处是合并变成秒级操作，不再全局串行阻塞几十分钟。

代价：如果合并时手工解决了冲突，解决得对不对**没有编译验证**。这条列为已知风险（见第 7 节），
由「合并后立刻在下一个需求 dev 时暴露」来兜底。

#### worktree 的生命周期

| 阶段 | worktree |
| --- | --- |
| 澄清 / 定稿 / 设计 / 技术方案 | **不需要**（只写 `data/<reqId>/`） |
| `dev` 进入时 | 创建，基于 `origin/<主分支>` |
| `dev` ～ `merge` | 使用中 |
| `merge` 成功 | 删 worktree + 删**本地** `feature/<reqId>` 分支 + 删 `data/<reqId>/`；**远端分支保留** |
| 需求 canceled / 长期 blocked | 巡检回收 |

#### 生命周期的清理策略

| 对象 | 合并成功后 | 为什么 |
| --- | --- | --- |
| worktree 目录 | 删除 | 已无用途，重建成本低 |
| 本地 `feature/<reqId>` 分支 | 删除 | 10 个需求就是 10 个分支，不删会越堆越多 |
| 远端 `feature/<reqId>` 分支 | **保留** | 追溯用；万一合并结果有问题，能查原始提交 |
| `data/<reqId>/` | 删除 | 文档已随合并提交进仓库，副本不再需要 |

清理放在 merge 成功之后、`wrapup` 之前。清理失败**不影响流程**——只记日志，下轮巡检再删。

#### 磁盘成本

实测主项目 291 MB，其中 `docs` 123 MB（历史需求累积）、`entry` 57 MB、`.git` 100 MB。

| 对象 | 大小 |
| --- | --- |
| `repo.git`（bare） | ~100 MB（一份） |
| 单个需求 worktree | ~60 MB（源码 + 构建配置，不含历史 docs） |
| 12 个 worktree | ~720 MB |

比原方案（每个 worktree 191 MB）省很多，因为历史 `docs` 不再被每个 worktree 检出。

#### 和用户本地工作区的关系

这台机器上还有一个用户自己的仓库：

```
~/Documents/ChatGPT/Instanto      ← 人手动写代码的地方（保留不动）
```

bot 不碰它。两者通过 **origin** 同步：

- bot 从 `origin` fetch，合并后 push 回 `origin`
- 用户 `git pull` 就能看到 bot 合并的代码

这条边界必须写清楚：**bot 只认 origin，不读用户本地工作区的未推送提交**。想被 bot 看到，先 push。

#### 双目录：文档和代码是分开的

`dev` 及之后的阶段，agent 同时面对两个路径：

| 用途 | 路径 | 哪些阶段在用 |
| --- | --- | --- |
| **写产物**（PRD、方案、报告） | `~/.qq-bot/data/<reqId>/` | 所有阶段 |
| **读写代码**（源码、单测、构建） | `~/.qq-bot/worktrees/<reqId>/` | `dev` ～ `merge` |

这是个容易出错的地方：agent 习惯了「产物和代码在一个仓库里」，很可能把技术方案写进 worktree，或者把代码改动留在 `data/` 目录。两种错误都不会报错，直到合并时才发现文档丢了或代码没进去。

所以任务包必须显式给出两段：

```
【产物位置】
- 文档（PRD / 设计说明 / 技术方案 / 各类报告）写到：
  /Users/xxx/.qq-bot/data/<reqId>/
- 代码（源码、单测、构建配置）改这里：
  /Users/xxx/.qq-bot/worktrees/<reqId>/
- 不要把文档写进 worktree，也不要把代码写进 data 目录——
  合并时文档从 data 复制归档，代码从 worktree 合并，写错地方就两边都缺。
```

对应到 `vars`：

```js
vars = {
  reqDir:    '~/.qq-bot/data/<reqId>/',        // 产物位置（保持不变，语义只是变了路径）
  workDir:   '~/.qq-bot/worktrees/<reqId>/',   // 代码位置（dev 之前为空）
  projectTree: '...',                          // 目录树，dev 阶段给 worktree 的
}
```

`reqDir` 的语义不变（还是「产物写这里」），只是从仓库内挪到了仓库外。各阶段 skill 里凡是提到
「产物写到需求目录」的地方都不用改文案，改的是这个变量指向哪里。

#### 各阶段的读写约定

| 阶段 | 读代码 | 写产物 |
| --- | --- | --- |
| req-questions / req-prd / design / tech-plan | 不需要 | `data/<reqId>/` |
| dev | `workDir` | 代码写 `workDir`；技术方案的「交付产物表」等更新写 `data/<reqId>/` |
| review / re-review | `workDir` | `data/<reqId>/` |
| test / acceptance | `workDir` | `data/<reqId>/` |
| merge | `_merge` worktree | 把 `data/<reqId>/` 复制进 `docs/requirements/<reqId>/` 后提交 |

#### 一个副作用：worktree 里没有历史需求文档

worktree 不含 `docs/requirements/` 下的历史需求（那 123 MB 被排除在检出之外）。所以 agent 在
`dev` 阶段**读不到别的需求的文档**。

这是刻意的：历史需求作为参考的价值不高，但把它们复制进 12 个 worktree 要吃掉 1.5 GB。

如果确实需要参考（比如「上次类似的弹窗怎么做的」），允许只读访问用户本地仓库：

```
/Users/xxx/Documents/ChatGPT/Instanto/docs/requirements/    ← 只读参考
```

**只读**是硬约束——往那里写会和用户的手动开发打架。skill 里要写明这一点。

---


### 4.2 并发控制：三层闸门

#### 第一层：需求状态不影响并发

100 个需求可以同时存在于任意阶段，但只有进入 `dev` ~ `merge` 的才占用重资源。

#### 第二层：worktree 池（默认 12）

```js
// 进入 dev 前申请，拿不到就排队
const slot = worktreePool.acquire(reqId)
if (!slot) { queue.park(reqId, '等待工作目录'); return }
```

#### 第三层：执行闸门（默认 2）

一个回合 = 一个 `dsh` 子进程，这是内存和 token 的真实成本。

```js
// flow-runner 起回合前
await executeGate.acquire()        // 超过 3 个就等
try { await runAgent(...) } finally { executeGate.release() }
```

**每需求串行**：同一需求同一时刻只有一个回合在跑（状态机天然保证，`current` 只会指向一个 checkpoint）。

#### 排队语义

| 情况 | 用户看到 |
| --- | --- |
| 等执行槽 | 「前面还有 2 个回合在跑，轮到你了会继续」 |
| 等 worktree | 「工作目录已满（10/10），有需求完成后自动分配」 |
| 队列持久化 | 写进 state，重启后恢复排队顺序 |

#### 默认值怎么定的

实测环境：16 GB 内存 / 500 GB 磁盘，鸿蒙工程 291 MB（`.git` 100 MB、`docs` 123 MB、`entry` 57 MB）。

| 配置 | 默认 | 依据 |
| --- | --- | --- |
| `maxConcurrentTurns` | **2** | 一个回合 = 一个 `dsh` 进程（200～500 MB）＋ 可能的 `hvigorw` 构建（JVM，1～2 GB）。16 GB 机器扣掉系统 4～6 GB，留 10 GB，2 个并发最坏约 5 GB，还有余量；3 个在「同时构建」时会顶到上限 |
| `maxWorktrees` | **12** | 单个 worktree ≈ 60 MB（bare 仓库模式下不检出历史 docs），12 个约 720 MB，500 GB 磁盘完全够；12 个需求同时处于开发期、配 2 个执行槽，排队深度合理 |

三个上限都进 `bot.config.json`：

```json
{ "limits": { "maxConcurrentTurns": 2, "maxWorktrees": 12 } }
```

跑顺之后可以上调——先保守，避免第一周就把机器拖死。

---

### 4.3 权限模型：动作级

#### 角色定义

| 角色 | 来源 | 范围 |
| --- | --- | --- |
| `superAdmin` | 配置文件（面板不可改） | 全局，不受任何限制 |
| `systemAdmin` | `adminUsers` 白名单（面板可改） | 全局「上帝权限」，任何群任何动作 |
| `owner` | OneBot `get_group_member_info` → `role === 'owner'` | 本群 |
| `admin` | 同上 → `role === 'admin'` | 本群 |
| `member` | 同上 → `role === 'member'` | 无 |

> 注意：**`systemAdmin` 与 `admin` 是两个概念**。前者是这套系统的管理员，后者是 QQ 群的管理员。

#### 动作权限表

| 动作 | owner | admin（群） | systemAdmin | member |
| --- | --- | --- | --- | --- |
| 发起需求 | ✅ | ❌ | ✅ | ❌ |
| 阶段确认（通过/打回） | ✅ | ✅ | ✅ | ❌ |
| 斜杠指令 | ✅ | ✅ | ✅ | ❌ |
| release / 交付 | ❌ | ❌ | ✅ | ❌ |
| 面板操作 | — | — | token 即授权 | — |

#### 实现

```js
const ACTIONS = {
  startRequirement: ['owner', 'systemAdmin'],
  confirm:          ['owner', 'admin', 'systemAdmin'],
  command:          ['owner', 'admin', 'systemAdmin'],
  release:          ['systemAdmin'],
}

async function can(action, groupId, userId) {
  const uid = String(userId ?? '')
  if (config.superAdmin.includes(uid)) return { ok: true, role: 'superadmin' }
  if (config.adminUsers.includes(uid)) return { ok: true, role: 'systemAdmin' }   // 上帝，先判
  const role = await memberRole(groupId, uid)                                     // 带 5 分钟缓存
  const allowed = ACTIONS[action] ?? []
  if (role && allowed.includes(role)) return { ok: true, role }
  return { ok: false, role, need: allowed }
}
```

判断顺序很重要：**系统管理员必须在群角色判定之前短路**，否则一个不是群管理的系统管理员会被拒。

#### 跨群代确认

不需要单独设计。系统管理员在任何群都有全权限（上面已短路），面板操作用 token 授权。

#### initiator 落盘

现在只在内存：

```js
{ initiator: { userId, nickname } }   // 进程重启即丢
```

改为写入 state：

```js
{
  initiator: { userId, nickname, at },
  confirmer: { userId, nickname, at, stage }   // 每次确认记录谁点的
}
```

用于审计：需求是谁发起的、每个阶段是谁确认的。

---

### 4.4 面板

#### 多需求视图

```
┌─ 执行槽 2/3 ────────────────────────────────┐
│ 群A / req-a1  dev    进行中 12m             │
│ 群B / req-b2  review 进行中 3m              │
│ 群C / req-c3  test   排队中（第 1 位）       │
└─────────────────────────────────────────────┘
┌─ Worktree 7/10 ─────────────────────────────┐
│ req-a1  ~/worktrees/a1   dev 起 占用中      │
│ ...                                          │
└─────────────────────────────────────────────┘
┌─ 全部需求（100） ───────────────────────────┐
│ 群号  需求  阶段  状态  发起人  最后活动      │
└─────────────────────────────────────────────┘
```

#### 访问控制

只给 1～2 人看，不做账号体系：

- 绑定 `127.0.0.1`，通过 SSH 隧道或内网访问
- 配置项 `panelToken`，URL 带 `?token=` 或 Header 校验
- token 即授权：**通过 token 的操作不再校验群角色**

---

### 4.5 可靠性（本期做前两项）

| 项 | 做法 | 优先级 |
| --- | --- | --- |
| 原子写状态 | 写临时文件 + `renameSync` | 高 |
| 子进程 detached | `spawn(..., { detached: true })` + `unref()` | 高 |
| 重启捡回回合 | state 为 `running` 且回执已落盘 → 视为完成继续推进 | 高 |
| `/healthz` | 返回连接状态、队列长度、活跃回合 | 中 |
| 面板端口可配 | `panelPort`，冲突时自动 +1 | 高（多实例前置） |
| 多实例 HA | 按群 flock 竞争消费 | 下期 |

#### 原子写

```js
save(groupId, state) {
  const file = this.#file(groupId)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)      // 同目录 rename 是原子操作
}
```

最坏情况保留上一次成功的状态，而不是产生不可解析的残缺 JSON。

#### 重启捡回

```js
// 启动时
for (const st of allStates()) {
  const flow = st.flow
  if (flow?.status !== 'running') continue
  const cp = currentCheckpoint(flow)
  if (cp && receiptExists(flow.reqDir, cp.id)) {
    // 活干完了（进程被杀但产物已落盘）→ 直接推进
    advanceFromReceipt(flow, cp)
  } else {
    // 真没干完 → 提示用户「回复继续重跑」
  }
}
```

---

## 5. 数据模型变化

```diff
 flow = {
   reqId, name, projectDir,
+  dataDir,                          // 需求文档目录（不进 git）：~/.qq-bot/data/<reqId>
+  workDir,                          // 代码工作区（dev 起 = worktree，之前为 null）
+  repoDir,                          // bare 仓库路径：~/.qq-bot/repo.git
   current, rounds, status, waiting, history,
   requestText, vars, roleSessions,
+  initiator: { userId, nickname, at },
+  confirmer: { userId, nickname, at, stage },
+  queue: { parkedReason, position, since },   // 排队状态
+  resources: { worktreePath, acquiredAt },    // 资源占用
 }
```

`bot.config.json` 新增：

```json
{
  "limits": {
    "maxConcurrentTurns": 2,
    "maxWorktrees": 12
  },
  "repoDir": "~/.qq-bot/repo.git",
  "worktreeRoot": "~/.qq-bot/worktrees",
  "dataRoot": "~/.qq-bot/data",
  "panelToken": "",
  "panelPort": 7878
}
```

---

## 5.5 迁移

改造上线时，已有数据要处理：

| 对象 | 处理 |
| --- | --- |
| 进行中的需求（state 里 `status` 非 `done`） | 迁到新架构：`reqDir` 改指向 `data/<reqId>/`，把现有 `docs/requirements/<reqId>/` 复制过去；`workDir` 指向新建的 worktree |
| 已完成的 state 文件 | 只改 `projectDir`/`reqDir` 字段指向新路径，不做其他处理 |
| 历史需求目录（`docs/requirements/` 下 20 个） | **不动**，继续留在仓库里作为归档 |
| `bot.config.json` | 新增 `repoDir`/`worktreeRoot`/`dataRoot`，移除 `projectDir`（或保留作为兼容兜底） |

迁移脚本要能重复执行（幂等），并且在动手前先备份 `.state/`。

## 6. 实施顺序与工作量

| 阶段 | 内容 | 工作量 | 依赖 |
| --- | --- | --- | --- |
| 1 | bare 仓库引导（首个需求时 `clone --bare`）+ 数据目录 `dataRoot` | 2 h | — |
| 2 | worktree 生命周期（dev 创建、merge 回收、孤儿巡检） | 3 h | 阶段 1 |
| 3 | 合并 worktree + `flock` 串行 + 文档归档提交（**不跑编译**） | 2 h | 阶段 1 |
| 4 | 三层闸门 + 排队持久化 | 2 h | 阶段 2 |
| 5 | 权限动作化（`can(action,...)`）+ initiator/confirmer 落盘 | 2 h | — |
| 6 | 原子写 + detached + 重启捡回 | 2 h | — |
| 7 | 面板多需求视图（槽位 / worktree / 队列） | 2 h | 阶段 2、4 |
| 8 | 面板 token + 端口可配 + `/healthz` | 1 h | — |
| 9 | 迁移脚本（历史 state + 进行中需求） | 1 h | 阶段 1-3 |

**合计约 16 小时**（不含并发测试，那部分见 `TODO.md`）。

阶段 1-3 是「存储与隔离」改造，必须一起交付——只做其中一个会让并发问题换个地方爆发。

阶段 1 和 3 都要改 `handleMessage` 入口，**建议一起做**，避免改两次。

---

## 6.5 回滚

**不需要专门的回滚方案。** 改造在独立分支 `refactor/team-scale` 上进行，上线方式是切换部署分支：

- 改造完成 → 合并到 `main` → 用 `main` 部署
- 上线后发现问题 → **切回改造前的 `main` 提交重新部署**，恢复时间是「重启进程」的量级

不走「代码回滚」是因为新架构改了数据布局（`data/` 目录、bare 仓库），代码回退后旧数据格式仍在，
不会互相破坏——旧版本读 `.state/` 时忽略未知字段即可。

**唯一需要注意的是**：改造上线后新产生的需求数据（`data/<reqId>/`）在旧版本里看不到。
如果需要保留，回滚前先把这些目录复制回 `docs/requirements/`。

## 7. 风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| worktree 磁盘增长 | 磁盘打满 | 上限 10 + 需求结束即回收 + 定期巡检孤儿目录 |
| 合并冲突（多个 feature 先后合入 main） | 后来的 merge 失败 | 已是现状：冲突时 abort 并转 dev agent 处理 |
| 并发下构建互相拖慢 | 单回合变慢 | 执行闸门默认 3，实测后调 |
| 权限收紧导致现有群不能操作 | 用户被拒 | 迁移时先告警不拦截（一版灰度） |
| 合并时手工解决冲突后没有编译验证 | 主分支可能编译不过 | 已知取舍（合并不跑编译是为了去掉全局串行阻塞）；冲突解决由 agent 负责，错误会在下一个需求 dev 时暴露。真出问题就 `git revert` 那个合并提交 |
| 主分支被并发 merge 破坏 | 影响所有人 | 合并 worktree 全局 `flock` 串行 + 每次 `reset --hard origin/<主分支>` |

### 明确不做

- 跨机器部署 / 分布式状态（团队规模不值得）
- 任务队列重投（回执机制已能判断「干没干完」）
- 用户账号体系（面板 token 足够）
- 多实例 HA（下期，等上服务器再做）

---

## 8. 验收标准

1. 两个需求同时进入 `dev`，各自的代码改动落在各自 `feature/<reqId>` 分支，主工作区不被切换
2. 群管理员发起需求被拒绝，群主可以；系统管理员在任意群可发起、可确认
3. 同时推进 10 个需求时，实际并发回合数 ≤ 配置上限，面板能看到排队
4. 需求 `merge` 成功后，worktree 被回收，`git worktree list` 不残留
5. 重启进程时，正在跑的回合不被杀，重启后该阶段被正确捡回
6. 状态文件在任意时刻被读，都是合法 JSON（原子写验证）
7. bot 目录下只有 `repo.git`（bare）、`worktrees/`、`data/`，**不存在被 checkout 的主工作区**
8. 两个需求同时在 `dev`，各自 `git status` 只显示自己的改动；一个需求 merge 时另一个不受影响
9. 需求进行期间所有文档在 `data/<reqId>/`，merge 后出现在仓库的 `docs/requirements/<reqId>/` 且内容一致
10. `dev` 回合结束后，`workDir` 里有代码改动、`data/<reqId>/` 里有更新后的技术方案，**两者都没有写错位置**
