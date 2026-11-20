# 安装指南

> 返回 [README](../README.md)

从零到在 App 里跑通第一个需求。遇到问题先看 [排错](TROUBLESHOOTING.md)。

## 一键脚本（推荐）

```bash
./install.sh
```

脚本会问你项目目录，然后自动完成：

| 步骤 | 做什么 |
| --- | --- |
| 1 | 检查 Node ≥ 22、`dsh`、`DEEPSEEK_API_KEY` |
| 2 | 把 `profiles/qqbot` 复制到 `~/.dsh/profiles/qqbot`（已存在则跳过） |
| 3 | 生成 `bot.config.json`（已存在则不覆盖，但会补上缺失的 `api` 段） |
| 4 | 跑 `node src/doctor.js` 自检 |

**幂等**，随时可以重跑，已配好的东西会跳过。

Windows 用 `install.ps1`，步骤一样，另外会帮你选模型供应商和填 API key：

```powershell
.\install.ps1 -Repo C:\work\my-app
```

### 参数

| 参数 | 作用 |
| --- | --- |
| `--project-dir <路径>` | 指定需求落地的项目目录，不再询问 |
| `-y` / `--yes` | 全部用默认值，不问任何问题（适合脚本化） |
| `--skip-doctor` | 跳过最后自检 |

`install.ps1` 对应 `-Repo` / `-Yes` / `-SkipDoctor`，另有 `-PanelPort` 和 `-ApiPort`。

### 脚本做不了的三件事

1. **填模型 API key**（Windows 脚本会问，macOS 读环境变量）
2. **启动服务**：`node src/index.js`
3. **注册第一个账号**：打开 App，服务器地址填 `http://<这台机器>:7881`，
   第一个注册的账号自动成为系统管理员

---

## 手动安装

想了解脚本在背后做了什么，或者要接管每一步，按下面来。

### 1. 前置条件

| 依赖 | 要求 | 怎么确认 |
| --- | --- | --- |
| Node.js | ≥ 22（需要内置 `fetch`） | `node -v` |
| `dsh` | 命令行可用，且已装 profile | `dsh --version` |
| DEEPSEEK_API_KEY | 环境变量，或存在 `~/.dsh/.credentials.yaml` | `echo $DEEPSEEK_API_KEY` |

> 本项目**零 npm 依赖**，`npm install` 不用跑，仓库 clone 下来就能起。
> 也不再需要 Docker、QQ、NapCat——那套已经删掉了。

### 2. 建 profile

仓库里的 `profiles/qqbot` 是从 headless 派生的模板，复制到 dsh 的 profile 目录：

```bash
cd ~/Documents/ChatGPT/qq-requirement-bot
cp -R profiles/qqbot ~/.dsh/profiles/qqbot
```

### 3. 写配置

```bash
cp bot.config.example.json bot.config.json
$EDITOR bot.config.json
```

**必改的只有 `repos`**（需求落到哪个仓库）。其余字段都有合理默认值，
含义见 [配置说明](CONFIG.md)。

想让手机连，`api.host` 保持 `0.0.0.0`；只在本机用就改成 `127.0.0.1`。

### 4. 自检

```bash
node src/doctor.js            # 配置 / 密钥 / skill / dsh
node src/doctor.js --turn     # 额外真跑一个回合（消耗 token）
```

第一项全绿再往下走。`--turn` 是可选的重度自检。

### 5. 启动

```bash
node src/index.js             # 前台跑，日志直接打屏
```

日志里出现 `App API：http://0.0.0.0:7881/healthz` 就是起来了。
浏览器打开那个地址应该返回 `{"ok":true,...}`。

常驻管理面板另开一个终端：

```bash
./start-panel.sh              # 默认 http://127.0.0.1:7879/console
```

### 6. 用 App 注册并提第一个需求

```bash
cd app
export PATH="$HOME/flutter/bin:$PATH"
flutter run -d macos          # 或在手机上跑
```

服务器地址填：

- macOS 桌面版：`http://127.0.0.1:7881`
- 手机（和这台机器同一 Wi-Fi）：`http://<这台机器的内网 IP>:7881`，
  macOS 下用 `ipconfig getifaddr en0` 查

注册完就能在列表页点「+」提需求了。

## 常见问题

| 现象 | 去哪看 |
| --- | --- |
| App 一直连不上 | [排错](TROUBLESHOOTING.md)：先看 `api.enabled` 和填的是不是内网 IP |
| `MISSING_CREDENTIAL` | 密钥没被读到，重新 `export` 或在 DSH Web GUI 的 Models 页保存 |
| 找不到 skill | 跑 `node src/doctor.js`，它会打印尝试过的全部路径 |
| 想给同事用 | 让他在同一网络下打开 App 填你的内网 IP，自己注册；你把他升成管理员即可 |
