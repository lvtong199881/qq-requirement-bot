# 运行时解耦技术方案（脱离 dsh）

> 状态：待评审　|　目标版本：0.3.0　|　影响范围：回合执行层、模型接入、多租户隔离

## 1. 背景

### 三个硬约束

| # | 约束 | 对现状的冲击 |
| --- | --- | --- |
| 1 | 部署到服务器，**不预装 dsh** | 每回合 `spawn dsh` 直接失败 |
| 2 | 需要**供应商池 + 故障切流** | dsh 的模型是 profile 里的进程级配置，改一次要重启 |
| 3 | **多租户** | 现在 `projectDir` 是全局配置，群只能覆写，没有租户维度 |

### 结论先说

**放弃 dsh 不是「要不要」的问题，是约束 2 决定的。**

dsh 把「选 provider + 发请求」封在宿主内部，configuration 落在
`~/.dsh/profiles/<name>/cordis.patch.yml`。一个 dev 回合可能有几十次模型调用，
而切流的最小粒度是「重启一个进程」——粒度太粗，等于没有。

但**不要一次换掉引擎**。真正的做法是分四步，每一步都能单独上线、单独回滚：

1. 把 `runTurn` 变成显式接口（**零行为变更**）
2. 用本地 OpenAI 兼容网关接管模型层（解决切流，不动 agent）
3. 换 worker 形态（解决服务器不装 dsh）
4. 多租户隔离（与 1～3 正交，可并行）

---

## 2. 现状：耦合面到底有多宽

### 2.1 bridge → dsh 的全部依赖

`src/runner.js` 是唯一出口，依赖只有五项：

| 依赖 | 位置 | 换 runtime 时怎么处理 |
| --- | --- | --- |
| `spawn(dshBin, ['--profile', p, '--json', '--session-id', sid, '-'])` | runner.js:36-51 | 换 argv 约定 |
| NDJSON 事件（`session` / `final` / `status.turn_end`） | runner.js:85-103 | 换适配器 |
| `cwd` 即沙箱边界 | flow-bridge.js:593 | **语义最重**，见 4.3 |
| session 存在 `~/.dsh` | flow-bridge.js:564-629 | 自存 messages |
| 模型凭证从 profile 推断 | config.js:88-91 | 由网关接管 |

**除这五项外，全链路与 dsh 无关**：状态机（`flow/flow.js` 纯函数）、prompt 编排
（`orchestrator.js` 自己读 SKILL.md）、回执与产物校验（读盘，不信 stdout）、
worktree / 合并 / 锁 / 槽位（纯 Node + git）、QQ 与面板。这是可脱耦的结构基础。

### 2.2 为什么 dsh 不适合多租户服务器

1. **启动要写 profile**。`prepareProfile` 会写 `~/.dsh/profiles/<name>/cordis.yml`。
   本机实测被沙箱拦成 `EPERM` 就是这个点，在服务器上表现为「容器里跑不起来」，
   而不是「配置不对」——排查成本高。要跑通必须同时满足：可写 DSH_HOME、预生成
   profile、Node 24、凭证注入，四条缺一不可。
2. **模型选择是进程级的**，与约束 2 直接冲突。
3. **打包形态重**。宿主 + profile + 插件依赖（`node_modules`）一起分发，
   不像单二进制能塞进镜像。

### 2.3 多租户的真实难点不在 agent

`src/flow-bridge.js` 里有 **24 处直接文件操作 + 23 处 `gitRun`**，全部作用在
agent 的工作区上：搬暂存区（`cpSync`）、清理产物（`rmSync`）、投递文件
（`existsSync` / `readFileSync`）、扫构建产物（`findLatestHap`）、合并（`git`）。

**如果 worker 被搬到远端机器，这 47 处都要改成 RPC。这是本方案最大的隐藏成本。**

→ 因此 4.4 定了一条硬决策：**工作区永远留在宿主机共享卷，容器只挂载它**。
bridge 的 fs 操作一行不改，隔离靠「容器只挂自己租户的路径前缀」+ 路径硬校验。

---

## 3. 目标与非目标

### 目标

- 服务器上不依赖「预装 dsh」，worker 可随镜像分发
- 模型层可配多个通道，**单次调用级**故障切流，用户无感
- 多租户：工作区 / 凭证 / 并发配额三者隔离，不串号

### 非目标（本期明确不做）

- **自研 agent loop**。先验证现成 headless CLI 够不够用，够用就不自研。
  自研是 0.4+ 的备选，触发条件见 7.2。
- 跨机器调度、worker 弹性伸缩
- 租户自定义工具集 / 自定义镜像
- 计费对账（只做用量记账，不做结算）

---

## 4. 方案

### 4.1 第一步：runtime 显式化（零行为变更）

把 `runner.js` 提到接口后面，config 加一项：

```json
{ "runtime": "dsh" }
```

```js
// src/runtime/index.js
export function createRuntime({ config, log }) {
  const impl = config.runtime === 'cli' ? createCliRuntime()
    : config.runtime === 'stub' ? createStubRuntime()
    : createDshRuntime()
  return { runTurn: impl.runTurn }
}
```

`runTurn` 的入参出参保持不变（现有 `flow-bridge.js:579` 的调用点一行不改）：
`{ dshBin, profile, projectDir, sessionId, prompt, env, timeoutMs, signal, onEvent, onChild }`
→ `{ sessionId, exitCode, timedOut, errorSummary, spawnFailed, envFailed }`。

**`stub` runtime 是本步的关键交付**：不调模型，按脚本写产物和回执，
用来跑通「无 agent 的全流程」。它同时是 e2e 测试基建（补 `TODO.md` 里
「多需求并发的自动化测试」那条缺口），也是「bridge 可脱离 dsh」的证明。

### 4.2 第二步：模型网关（解决切流）

本地起一个 OpenAI 兼容 HTTP 服务，只监听 `127.0.0.1`：

```
worker(任意 agent CLI) ──► 127.0.0.1:7890/v1/chat/completions ──► 通道池
```

对 agent 而言它就是一个 `baseURL`；对 bridge 而言模型层从此可控。

**通道配置**（`providers.json`，按租户可覆盖）：

```json
{
  "channels": [
    {
      "id": "opencode-go",
      "protocol": "openai",
      "baseURL": "https://…/v1",
      "apiKeyEnv": "OPENCODE_GO_API_KEY",
      "models": ["hy3", "hy4-preview"],
      "weight": 100,
      "cooldownMs": 300000
    },
    { "id": "workbuddy", "protocol": "openai", "weight": 50 },
    { "id": "deepseek", "protocol": "openai", "weight": 10 }
  ]
}
```

**内部统一用 OpenAI messages 格式**，只在 adapter 层转 Anthropic。
不做这一步，切流时同一 session 换 provider 会因格式差异直接断掉。

**切流决策表**（分类逻辑直接复用 `runner.js:106-134` 已经踩出来的经验）：

| 上游返回 | 动作 | 理由 |
| --- | --- | --- |
| 429 / 402 / 5xx / 超时 / 网络错 | 降权该通道，同一次请求换下一个 | 换谁都能跑 |
| 400 / 422 / 内容审核 | **不切流**，原样抛给 agent | 换谁都一样错，切了是白烧钱 |
| 401 / 403 | 标记通道失效，告警 | 凭证问题，重试无意义 |

**工程关键点：切流窗口只到「首个 token 之前」。**
一旦 SSE 开始吐字，中途换通道会让前端看到两段拼接的文本。
所以实现上：
- 请求发出 → 等到首 token：可切流
- 首 token 之后失败：该次调用判失败，交给 agent loop / 返工逻辑
- 这也意味着**非流式**实现更简单先上线，流式作为后续优化

**熔断**：连续 N 次失败 → 冷却 `cooldownMs`；冷却结束后放一个探测请求，
成功才恢复权重。用量按租户累计（`usage` 字段），只记账不结算。

### 4.3 第三步：worker 形态（解决「不装 dsh」）

保守路线用**单二进制 headless CLI**，容器里跑。候选与验证点：

| 候选 | 为什么可能合适 | 必须先验证 |
| --- | --- | --- |
| opencode | 单 Go 二进制，易塞镜像 | headless 是否支持 session 续跑 |
| claude code | `-p` + `--output-format stream-json` + `--resume` 比较成熟 | 是否可指向自定义 baseURL |
| codex CLI | 同上 | 工具集是否够（bash + 文件读写） |

**Spike 清单（1～2 天，只出结论不写生产代码）**：

1. 能否 `--session-id` 续跑同一会话？不能 → 多阶段续跑废掉，路线改自研
2. 能否指向本地网关的 `baseURL`？不能 → 约束 2 解决不了，路线改自研
3. 有没有 bash / read / write / edit / grep / glob？SKILL.md 里写的是 hvigor、hdc 命令
4. 有没有 NDJSON 或 stream-json 事件流？没有 → 只能靠回执文件，勉强可用
5. 进程退出码与错误是否可判？超时能否杀干净？

**五个问题里 1 或 2 答否，就直接转自研**（自研工作量见 6 节，范围明确）。

**容器形态**：

```
镜像：node:22 + 鸿蒙工具链 + worker 二进制 + git
挂载：/workspace → <tenantRoot>/worktrees/<reqId>   （只挂自己租户的）
限制：CPU / 内存 / 网络出口 / 只读根文件系统
```

注意：`cwd` 即沙箱边界这条语义要平移——容器里 `WORKDIR=/workspace`，
agent 只能写挂载进来的那一个目录。

**硬约束：换 worker 与上容器必须同一个版本上线，不能分期。**
现在 `bash` 工具的安全边界是 dsh 的 workspace-write 沙箱。一旦用容器外的 CLI
替换它，而容器还没上，agent 就获得了宿主机 shell——而 prompt 里拼的是 QQ 群
消息原文（不可信输入）。多租户下这意味着「租户 A 的群友可以通过 prompt 让
agent 读租户 B 的工作区」。这个窗口不能开。

### 4.4 第四步：多租户隔离

**数据模型**（新增 `tenants.json`）：

```json
{
  "tenants": [
    {
      "id": "t-acme",
      "name": "Acme",
      "root": "~/bot-data/t-acme",
      "repos": [{ "id": "instanto", "remoteUrl": "git@…", "mainBranch": "main" }],
      "groups": ["874368541"],
      "quota": { "maxWorktrees": 4, "maxConcurrentTurns": 2 },
      "providers": ["opencode-go", "workbuddy"]
    }
  ]
}
```

**隔离边界**：

| 维度 | 手段 |
| --- | --- |
| 工作区 | `<tenantRoot>/worktrees/<reqId>`，容器只挂这一个子目录 |
| 仓库 | 每租户独立 bare 仓库 + 独立 `repoDir` / `worktreeRoot` |
| 凭证 | 优先「租户自带 key」；共享池模式必须记账到租户（见 7.3） |
| 并发 | `SlotPool` 按租户建池（复用现有 `infra/lock.js`，改成两段命名空间） |
| 路径 | 所有 fs 入口前置 `assertInTenant(realpath, tenant.root)`——**这是防串号的唯一硬边界** |

**向后兼容**：`tenants.json` 不存在时，用现有 `bot.config.json` 合成一个默认租户
（`root` = 现在的 `repoDir` 父目录），行为与今天完全一致。迁移是纯增量。

---

## 5. 与多租户的正交关系

这两件事**互相独立**，交汇点只有一个：worker 在哪跑。

```
多租户改造 ──┐
             ├──► 交汇点：worker 的执行边界（挂载哪个目录）
runtime 解耦 ┘
```

所以可以：先做多租户（不动 runtime，dsh 还能用）→ 再做 runtime；
或反过来。**不建议同时动**，否则出问题时无法判断是租户边界错了还是 runtime 错了。

优先级建议：**多租户的「租户模型 + 路径硬校验」优先于 runtime 解耦**。
因为 `projectDir` 现在是全局配置，多租户是数据模型级改动，越晚做迁移成本越高
（要改已有 state 文件和目录布局）。

---

## 6. 实施顺序与工作量

| 阶段 | 内容 | 人日 | 风险 | 可独立回滚 |
| --- | --- | --- | --- | --- |
| 0A | `runtime/` 抽象 + `stub` runtime + e2e 测试 | 1～2 | 极低 | 是（默认仍走 dsh） |
| 0B | 模型网关 + 通道池 + 切流 + 熔断 | 3～5 | 中 | 是（`baseURL` 指回去） |
| 0C | worker spike（只验证 5 个问题） | 1～2 | **高（结论不确定）** | — |
| 0D | worker 落地 + 容器镜像 | 4～6 | 高 | 是（切回 dsh） |
| 1 | 租户模型 + 路径硬校验 + 配额 | 5～8 | 高 | 是（兜底默认租户） |
| 1B | 容器化多租户上线 | 3～4 | 高 | 是（先单租户） |
| 2 | 自研 runtime（备选，见 7.2） | 15～25 | 中高 | — |

---

## 7. 风险与取舍

### 7.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| CLI 不支持 session 续跑 / 自定义 baseURL | 中高 | 高（路线作废，转自研） | 0C spike 先出结论，1～2 天止损 |
| 网关流式透传有 bug | 中 | 中（agent 变傻，难查） | 先非流式；单租户灰度；对比日志 |
| 容器内缺工具链（鸿蒙 SDK） | 高 | 中（镜像大，构建慢） | 镜像预装并缓存；镜像体积是必然代价 |
| bridge 直接 fs 操作与容器冲突 | 中 | 高 | 4.4 的硬决策：工作区留宿主机 |
| 多租户写错别人工作区 | 中 | **极高（数据破坏）** | `assertInTenant` 硬校验 + 容器只挂子目录 + 并发测试 |
| 长任务稳定性低于 dsh | 中 | 中 | dsh 保留为 fallback runtime，灰度期不删 |

### 7.2 什么时候才该自研

三个条件**同时**成立才做：0C 的 5 个问题里 1 或 2 答否；且需要回合内精确控制
（token 预算、工具白名单、回执工具化）；且现成 CLI 的许可证/依赖不可接受。
否则不要自研——自研的长期成本在上下文压缩和长任务稳定性，不在 loop 本身。

### 7.3 取舍：共享凭证 vs 租户自带

- **共享池**：接入快，但成本无法归因，一个租户跑飞会烧掉所有人的额度
- **租户自带**：干净，但 onboarding 要用户自己配 key

建议：**两种都支持，默认共享池 + 强制按租户记账**，等有付费租户再切自带。

### 7.4 明确不做

- 不做 agent 引擎的深度定制（提示词模板、工具编排 UI）
- 不做多机调度：单机多容器足够撑到几十个租户
- 不做实时计费/对账
- 不删 dsh 支持：它是最省事的 fallback，删了就没有对照基线

---

## 8. 验收标准

1. `runtime: "stub"` 下，全流程（req → … → wrapup）跑通，零 dsh 进程
2. 网关：杀掉主通道，同一个回合内自动切到备用，群消息不出现异常
3. 网关：非流式请求的切流成功率 100%（注入故障测试）
4. 服务器镜像不含 dsh，`docker run` 后一个需求能跑完全程
5. 两租户并发跑 dev，各自产物落在各自 worktree，`assertInTenant` 无告警
6. 租户 A 的 agent 尝试写租户 B 路径 → 被拒 + 告警，流程不崩
7. dsh 仍可作为 `runtime: "dsh"` 正常工作（对照基线）
