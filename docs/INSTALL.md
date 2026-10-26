# 安装指南

> 返回 [README](../README.md)

从零到在群里跑通第一个需求。遇到问题先看 [排错](TROUBLESHOOTING.md)。

## 一键脚本（推荐）

```bash
./install.sh
```

脚本会问你项目目录和 QQ 号，然后自动完成：

| 步骤 | 做什么 |
| --- | --- |
| 1 | 检查 Node ≥ 22、`dsh`、`DEEPSEEK_API_KEY`、requirement-spec skill |
| 2 | 把 `profiles/qqbot` 复制到 `~/.dsh/profiles/qqbot`（已存在则跳过） |
| 3 | 生成 `bot.config.json`（已存在则不覆盖） |
| 4 | 准备 NapCat：**没装 Docker 就用 Homebrew 装**；容器没建就建、停了就起；最后检查 OneBot 端口 |
| 5 | 跑 `node src/doctor.js` 自检 |

Docker 是跑 NapCat 的强依赖，脚本会负责到底：`docker` 命令不在就 `brew install --cask docker`，
装了但 daemon 没起就拉起来并等它就绪（最多 3 分钟）。Docker Desktop 首次启动要在界面里
接受协议、输一次管理员密码——这一步没法自动化，脚本会提示你。

**幂等**，随时可以重跑，已配好的东西会跳过。

### 参数

| 参数 | 作用 |
| --- | --- |
| `--project-dir <路径>` | 指定需求落地的项目目录，不再询问 |
| `--qq <QQ号>` | 写进 `superAdmin` |
| `-y` / `--yes` | 全部用默认值，不问任何问题（适合脚本化） |
| `--no-napcat` | 跳过第 4 步，自己管 NapCat |
| `--skip-doctor` | 跳过最后自检 |
| `--dry-run` | 只打印会执行的操作，不动系统（预览用） |

### 脚本做不了的 3 件事

1. **登录 QQ**：浏览器打开 `http://127.0.0.1:6099/webui`，用手机 QQ 扫码（仅首次，登录态存在数据卷里）
2. **把 bot 拉进群**：群号不用填配置，它会自己发现
3. **在群里说第一句话**：`node src/index.js` 启动后 @ 它

---

## 手动安装

想了解脚本在背后做了什么，或者要接管每一步，按下面来。

### 1. 前置条件

| 依赖 | 要求 | 怎么确认 |
| --- | --- | --- |
| Node.js | ≥ 22（需要内置 `WebSocket` 和 `fetch`） | `node -v` |
| `dsh` | 命令行可用，且已装 `headless` profile | `dsh --version` |
| DEEPSEEK_API_KEY | 环境变量，或存在 `~/.dsh/.credentials.yaml` | `echo $DEEPSEEK_API_KEY` |
| Docker | 走 Docker 路线跑 NapCat 时必需（脚本会自动装） | `docker info` |
| NapCat | 一个 QQ 号，开启**正向 WebSocket** | 见下一节 |
| requirement-spec skill | 一份带 `name: requirement-spec` 的 skill 目录 | 见下文 |

> 本项目**零 npm 依赖**，`npm install` 不用跑，仓库 clone 下来就能起。

### 2. 准备 NapCat

NapCat 是 OneBot 11 协议端，**非官方**，有封号风险——用小号，并保持 `maxMessagesPerMinute` 不要调高（见 [已知限制](../README.md#已知限制)）。

两种装法，任选：

**Docker（推荐，可脚本化）**

```yaml
# 保存为 ~/napcat/docker-compose.yml，WEBUI_TOKEN 换成自己的
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      MODE: ws
      WEBUI_TOKEN: replace-with-your-own-token
    ports:
      - "127.0.0.1:6099:6099"
      - "127.0.0.1:3001:3001"
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
```

```bash
cd ~/napcat && docker compose up -d
```

**macOS 官方安装器（图形界面）**

1. 安装 QQ 到 `/Applications/QQ.app`
2. 下载 [NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest)，选择下载方式并安装
3. 按提示授权修改 QQ 入口，切换到 NapCat 后启动

装好后都进入同一个 WebUI 登录：

1. 浏览器打开 `http://127.0.0.1:6099/webui`（Docker 方式需要 compose 里设的 token）
2. 用手机 QQ 扫码登录**小号**
3. 在 WebUI 里确认**正向 WebSocket** 已启用，端口 `3001`
4. 记下地址（`ws://127.0.0.1:3001`）和 token，填进配置

### 3. 准备 requirement-spec skill

把 skill 放到下面任意一个位置即可，bridge 会按顺序探测，**不需要改配置**：

```
$QQ_RS_SKILL_ROOT/requirement-spec
~/.agents/skills/requirement-spec
~/.dsh/skills/requirement-spec
<仓库上级目录>/skills/requirement-spec
<仓库>/skills/requirement-spec
```

判定标准：该目录下有 `SKILL.md`，且文件头的 frontmatter 含一行 `name: requirement-spec`。换机器、目录搬家都不用重新配。

只有确实要指向特殊位置时，才在 `bot.config.json` 里显式写 `skillDir`。

### 4. 建 qqbot profile

仓库里的 `profiles/qqbot` 是从 headless 派生的模板，复制到 dsh 的 profile 目录：

```bash
cd ~/Documents/ChatGPT/qq-requirement-bot
cp -R profiles/qqbot ~/.dsh/profiles/qqbot
```

### 5. 写配置

```bash
cp bot.config.example.json bot.config.json
$EDITOR bot.config.json
```

**必改的只有 `projectDir`**（需求落在哪个项目里）。群号不用填——bot 连上 NapCat 后会自己报出它所在的群。

其余字段（限流、心跳、上传白名单、群策略、superAdmin）都有合理默认值，含义见 [配置说明](CONFIG.md)。

### 6. 自检

```bash
node src/doctor.js            # 配置 / 密钥 / skill / dsh / OneBot 连通性
node src/doctor.js --turn     # 额外真跑一个回合（消耗 token）
```

第一项全绿再往下走。`--turn` 是可选的重度自检。

### 7. 启动与验证

```bash
node src/index.js             # 前台跑，日志直接打屏
```

常驻管理面板另开一个终端：

```bash
./start-panel.sh              # 默认 http://127.0.0.1:7879/console
```

把 bot 拉进群，@ 它说一句：

```
@产品同学 首页加个欢迎弹窗，手动批准
```

收到「收到，开始处理」之类的回执就算通了。

## 常见问题

| 现象 | 去哪看 |
| --- | --- |
| 启动但群里没反应 | [排错](TROUBLESHOOTING.md)：先查 `bot.qq` 与 `frame.self_id` 是否一致 |
| `MISSING_CREDENTIAL` | 密钥没被读到，重新 `export` 或在 DSH Web GUI 的 Models 页保存 |
| 连不上 ws | NapCat 的正向 WS 没开，或端口/token 不对 |
| 找不到 skill | 跑 `node src/doctor.js`，它会打印尝试过的全部路径 |
