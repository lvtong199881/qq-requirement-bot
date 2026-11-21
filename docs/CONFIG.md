# 配置说明

> 返回 [README](../README.md)

全部配置都在仓库根目录的 `bot.config.json` 里，首次从 `bot.config.example.json` 复制（见[安装指南](INSTALL.md)第 4 步）。

**会话不用配。** 在 App 里点「建群」起个群名，服务端自动给它一个 threadId，
状态、消息、产物都挂在这个 id 下面。群里不 @ 需求 bot 就只是聊天，@ 一句才开始跑需求。
配置文件里不需要列出任何会话。

```jsonc
{
  // 需求要落到哪些仓库。单仓库写一项即可；给了 url 时 bot 会自己 clone。
  "repos": [
    { "id": "app", "name": "Instanto", "path": "~/Documents/ChatGPT/Instanto", "platform": "harmony" }
  ],
  "dshBin": "dsh",
  "profile": "qqbot",

  // 模型供应商由你自己填，留空则完全沿用 dsh profile 的默认行为。
  // apiKeyEnv 是供应商读 key 的环境变量名，bridge 会把它注入 dsh 子进程。
  "model": { "provider": "opencode-go", "model": "deepseek-v4.1-flash", "apiKeyEnv": "OPENCODE_GO_API_KEY" },

  // 机器人账号的昵称。服务启动时会把它写进用户表（id `u_bot`、username `bot`、
  // role `bot`）：@ 它才算对 agent 说话。改这里等于改名，改完只认新名字。
  "bot": { "name": "AI员工" },

  "approval": "manual",                            // manual = 每阶段等确认；auto = 自动推进

  "limits": {
    "maxConcurrentTurns": 2,                       // 同时最多跑几个回合
    "maxWorktrees": 12                             // worktree 池上限
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
  "turnTimeoutMs": 1800000,                       // 兼容旧配置：没有 stageTimeouts 时当作默认值

  // 给 Flutter App 用的 API。这是唯一的入口，见下面「App API」一节
  "api": {
    "enabled": true,
    "port": 7881,
    "host": "0.0.0.0",
    "allowedOrigin": "",
    "maxBodyBytes": 1000000,
    // 引擎密钥：IM 和需求引擎分开跑时用。留空则由 src/im.js 首次启动自动生成，
    // 落 .state/engine-token 并打印一次（抄进引擎那台机器的 im.token）
    "engineToken": ""
  },

  // 只有 src/engine.js 读这一段，单机跑 src/index.js 时完全不看
  // 分开部署：IM 在这台（src/im.js），引擎在那台（src/engine.js）
  "im": {
    "url": "http://192.168.1.10:7881",
    "token": "",
    "pollWaitMs": 25000
  }
}
```

## App API

给手机 App 用的那套 HTTP 服务。这是团队提需求、拍板的唯一入口，
和面板是两个独立端口，接口细节见 [API.md 的 App API 一节](API.md#app-api)。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉 App 就连不上，只剩面板能看 |
| `port` | `7881` | 独立端口，别和 `panel.port`(7878) 撞 |
| `host` | `0.0.0.0` | `cloudflared` / `tailscale` 要能连进来。想更保守就写 `127.0.0.1` 再本机反代 |
| `allowedOrigin` | `""` | CORS 白名单，留空则按请求的 `Origin` 回显。App 是原生请求，用不到 |
| `maxBodyBytes` | `1000000` | 单请求体上限 |
| `engineToken` | `""` | 引擎密钥。留空时 `src/im.js` 首次启动自动生成并打印一次 |

### IM 与引擎分开部署

默认 `node src/index.js` 一个进程里两样都有。想把 IM 当成普通聊天工具用（不需要做需求时也能挂着），就拆开：

| 进程 | 入口 | 配置它要的 |
| --- | --- | --- |
| IM | `node src/im.js` | 只有 `api` 段；`model`、`repos` 都可以空着 |
| 引擎 | `node src/engine.js` | `im.url` + `im.token` + 正常的 `model`/`repos` |

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `im.url` | `""` | IM 的地址，例如 `http://192.168.1.10:7881`；引擎主动连它 |
| `im.token` | `""` | 引擎密钥，来自 IM 启动时打印的那行或 `.state/engine-token` |
| `im.pollWaitMs` | `25000` | 长轮询每次最多挂多久（上限 30 秒），小一点断线恢复更快、请求更频繁 |

顺序不能反：先起 IM 拿到密钥，再起引擎。IM 侧 70 秒收不到轮询就把引擎当离线，App 列表顶部会提示「需求引擎没连上」，群照样能聊。从来没连上过的部署（只拿 IM 当聊天工具用）不会提示，`online` 返回 `null`。

### 开在 0.0.0.0 的代价

这个进程能 spawn dsh 回合、在本地仓库里跑 git。绑 `0.0.0.0` 是为了手机能连，
代价是同网段的机器都能访问到它。

预设管理员（`admin` / `123456`）把「谁先抢注谁是管理员」这个坑堵上了——
别人抢注也拿不到管理员，但**他能用 admin/123456 登进来**。所以第一次启动完
就去做两件事之一：

- 登录后立刻在「账号管理」里改掉密码（推荐）
- 或者把 `host` 写成 `127.0.0.1`，用 Tunnel 转发进来，端口不直接对外

只想在本机用 App（macOS 桌面版）就一直 `127.0.0.1`。

### 和面板的区别

| | `panel`（7878 / 7879） | `api`（7881） |
| --- | --- | --- |
| 只听回环 | ✅ | ❌（要公网） |
| 鉴权 | token 为空时**直接放行** | 必须用户名密码登录 |
| 能停会话 / 改配置 | ✅ | ❌ |

**绝不能**把 `panel` 那个端口暴露出去。它有 `stop`/`restart`/`applySettings`，
而 `src/ui/server.js` 的 `needToken` 在没配 token 时直接返回 `true`。

### 账号从哪来

服务第一次启动时会建一个**预设管理员**：`admin` / `123456`。

- 只在用户表为空时创建，所以改过密码、加过账号之后它不会再出现
- 表非空但没有可用管理员时**不会**自动补一个（那等于留后门），只在日志里提示
  删掉 `.state/users.json` 可以回到初始状态
- 预设账号就是普通管理员，能被降级、能停用，也受「最后一个管理员不能降级/停用」约束
- 登录页会直接显示这组账号密码（后端 `/api/auth/status` 返回），改过密码后就不再显示

之后的人在 App 里注册拿到的都是普通成员，要提权得由管理员在「账号管理」里改。
没有了找回密码流程——忘了密码让管理员重置。

### 公网怎么通

推荐 Cloudflare Tunnel，不需要公网 IP、不需要备案：

```bash
# 一次性
cloudflared tunnel login
cloudflared tunnel create qq-bot
cloudflared tunnel route dns qq-bot bot.example.com

# 常驻
cloudflared tunnel run --url http://127.0.0.1:7881 qq-bot
```

免费版 `xxx.trycloudflare.com` 每次重启换地址，App 里 baseURL 写死就废了，
所以得有自己的域名（十来美元一年，DNS 和证书都免费）。

要注意的几点：

- **国内访问质量一般。** 免费版走海外节点，纯文本轮询还行，几个 MB 的设计稿会比较慢
- **Mac 得常开。** bridge 要 spawn 回合、跑 git、读写本地目录，搬不到 Workers 上去
- **别用 SSE 长连接。** Cloudflare 对长连接有流式超时。这套本来就是「打开 App 才看消息」，
  每 3~5 秒轮询一次即可，没有超时也没有重连逻辑
- **免费版 ToS 限制大量非 HTML 内容分发**，团队内部几十张图和 md 文件没问题

替代方案：香港/新加坡的小 VPS 自建反代（同样免备案），或者用 Tailscale 组私有网——
后者只在自己设备上装，连域名都不用买。


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

超时不是「失败重试」，是**直接中断这一回合**。中断后该会话状态停在 `running`，
发一句「继续」会从当前阶段重跑（产物和分支都在，不会重头来）。

**关于 `repos`**：`id` 是内部标识（路径按它派生，建了就别改）；`name` 是给人看的；`path` 和 `url` 二选一，给了 `url` 就由 bot 克隆到 `checkoutRoot`。`platform` 决定用哪套工具链（`harmony` / `android` / `ios`）。

## 模拟器工具路径

模拟器服务用 `emulator` / `adb` / `avdmanager` 管理 Android AVD。这三个默认按名字从 PATH 找，
而 SDK 的 `emulator` 目录一般不在 PATH 上——找不到时服务会报 `spawnSync emulator ENOENT`，
把绝对路径写进 `tools.android` 即可：

```json
"tools": {
  "android": {
    "bin": "C:\\Users\\you\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe",
    "adb": "C:\\Users\\you\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe",
    "avdmanager": "C:\\qq-bot\\scripts\\avdmanager.cmd"
  }
}
```

- `bin` / `adb` 是列设备、启停模拟器、装包用的，必配。
- `avdmanager` 只在删除 AVD 时用；它要求 JDK 17+，而 Flutter 构建这边 `JAVA_HOME` 通常是 11。
  仓库里的 `scripts/avdmanager.cmd` 只在这一次调用里切到 Android Studio 自带的 JBR，不动全局环境。
- AVD 存在 `%USERPROFILE%\.android\avd`，服务用 `emulator -list-avds` 发现，系统版本从各 AVD 的
  `config.ini` 里读（Android 5.0 ~ Android 17 有中文叫法）。
- 模拟器的 ABI 是 x86_64，而 `flutter build apk` 的默认变体只带 arm64 时，装进模拟器会在启动
  瞬间崩（`libflutter.so is for EM_AARCH64 ... instead of EM_X86_64`）。要在模拟器上跑，用
  `flutter build apk --debug --target-platform=android-x64` 单独构建一份。

## 编排

流程由 bridge 的状态机驱动（`src/flow.js` 的 `CHECKPOINTS` 表）：当前阶段、返工次数、
在等谁回答都由代码决定，不解析任何文本。每个阶段是一个独立回合，只加载
`skills/<角色>/SKILL.md` 那一份角色卡。

阶段顺序：需求澄清 → 需求定稿 → 设计 → 技术方案 → 开发 → 代码评审 → 测试 → 验收 → 合并 → 收尾。

`approval: "manual"` 时，每个阶段产出后停下等你回「通过」或「打回」。
开发阶段在 `feature/<需求标识>` 分支上进行，验收通过后由开发回合合并回主分支。
