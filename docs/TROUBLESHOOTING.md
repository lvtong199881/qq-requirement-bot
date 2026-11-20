# 排错

> 返回 [README](../README.md)

先跑自检，它会把配置、密钥、dsh、App API 端口一次性列出来：

```bash
node src/doctor.js
```

## 常见现象

| 现象 | 排查 |
| --- | --- |
| App 一直「连不上服务器」 | `api.enabled` 是不是 true；手机填的是不是本机**局域网 IP**（不是 127.0.0.1）；`api.host` 是不是 0.0.0.0；macOS 防火墙有没有拦 node |
| App 连上了但登录 401 | token 过期（7 天）或这个账号被停用了，重新登录 |
| 注册时提示「用户名已存在」 | 换一个。忘了密码只能让管理员在 App 的「账号管理」里重置 |
| 点了「通过」提示没有权限 | 这个账号是普通成员。让管理员在「账号管理」里改成系统管理员 |
| `MISSING_CREDENTIAL` | `export DEEPSEEK_API_KEY=...`，或在 DSH Web GUI 的 Models 页保存 |
| 找不到 skill | 角色卡在仓库的 `skills/<角色>/SKILL.md`，不是全局 skill 目录 |
| `启动 dsh 失败（ENOENT）` | `bot.config.json` 的 `dshBin` 指向真实路径，别只写 `dsh` |
| `文件权限不足（EPERM）` | bridge 在受限环境里跑，dsh 写不了 `~/.dsh`。从普通终端启动 |
| 阶段反复重跑、返工次数一直涨 | agent 没写 `_receipt-<阶段>.json` 或产物没落盘，看 `.logs` 里同阶段的回合记录 |
| App 里看不到刚建的需求 | 列表只认 App 建的 thread；老机器上 QQ 时代的 `group-<群号>.json` 会被过滤掉，这是有意的 |
| 产物点开是 404 | 产物存在 `.state/artifacts/<thread>/` 下，清过 `.state` 就没了 |
| 面板显示「旧版需求」 | 那个会话绑的是早期版本的需求，v2 不接管，重新提一个就行 |
| 启动时警告「这些键已经失效」 | 老配置里还写着 `onebot` / `superAdmin` / `groupPolicy` 这些 QQ 时代的段落。它们现在完全不读，删掉即可，或照 `bot.config.example.json` 重生成一份 |

## 从 QQ 版本升级上来

老机器上的 `bot.config.json` 里有一批键现在不读了（启动会逐个列出来）：

| 已失效 | 原来干什么 | 现在怎么办 |
| --- | --- | --- |
| `onebot` | 连 NapCat 的 WebSocket 地址 | 不需要，App 直接调 API |
| `bot.qq` | 认 QQ 群里的管理员用 | 身份来自用户表，第一个注册的是管理员 |
| `groups` | 手动指定服务哪些群 | 不需要，App 里点「+」新建就行 |
| `groupPolicy` / `excludeGroups` | 哪些群能用、哪些不能用 | 权限只看账号（系统管理员 / 普通成员） |
| `superAdmin` / `adminUsers` | QQ 号白名单 | 在 App 的「账号管理」里改角色 |
| `limits.maxMessagesPerMinute` 等三项 | 防 QQ 风控的限速 | App 没有平台限速，删掉 |

留着不会报错，只是不生效。`.state/` 里的老群状态文件也还认得（用 `group-` 前缀区分），
App 列表会把它们过滤掉，不会误显示成你自己建的需求。

## 卡在哪一步

状态机把当前进度写在各会话的状态文件里：

```bash
cat .state/group-<threadId>.json | python3 -m json.tool
```

看 `flow.current`（当前阶段）、`flow.status`（running / waiting_user / blocked / done）、
`flow.rounds`（各阶段返工次数）。编排记录 `docs/requirements/<需求ID>/编排记录.md`
是同一份状态的易读版本。

> 文件名里的 `group-` 是 QQ 时代留下的前缀，里面装的其实是 App 的 threadId。
> 改名要动上百处、零行为收益，所以留名改语义。

## 回合卡住不退出

dsh 子进程可能挂住不退出（工具调用超时、等网络）。表现是日志停在 `v2 回合：<阶段>`，
会话文件的修改时间不再变化。处理办法：

```bash
kill <bridge PID>    # 子进程会一起退
node src/index.js    # 重启后该需求停在 running，在对话框里发「继续」重跑当前阶段
```

**不要**直接删 `.state/`——那会丢进度和账号表。

## 想从公网访问

不用开端口、不用备案、不用公网 IP，用 cloudflared 隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:7881
```

免费版的 `*.trycloudflare.com` 每次重启换地址，App 里写死的 baseUrl 就废了，
所以正式用要绑自己的域名。细节和四个坑见 [CONFIG.md](CONFIG.md#app-api)。

## 看日志

- **落盘**：`.logs/bridge-YYYY-MM-DD.log`，按天切分（UTC 日期）
- **内存**：最近 500 条，面板的「详细信息」弹窗能直接看
- **打屏**：`verbose: true` 会输出每个事件和 token 用量

排错时先把 `verbose` 打开，比猜快得多。
