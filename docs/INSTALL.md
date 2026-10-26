# 安装指南

从零到在群里跑通第一个需求，大约 10 分钟。遇到问题先看主 README 的「排错」表。

## 1. 前置条件

| 依赖 | 要求 | 怎么确认 |
| --- | --- | --- |
| Node.js | ≥ 22（需要内置 `WebSocket` 和 `fetch`） | `node -v` |
| `dsh` | 命令行可用，且已装 `headless` profile | `dsh --version` |
| DEEPSEEK_API_KEY | 环境变量，或存在 `~/.dsh/.credentials.yaml` | `echo $DEEPSEEK_API_KEY` |
| NapCat | 一个 QQ 号，开启**正向 WebSocket** | 见第 2 步 |
| requirement-spec skill | 一份带 `name: requirement-spec` 的 skill 目录 | 见第 3 步 |

> 本项目**零 npm 依赖**，`npm install` 不用跑，仓库 clone 下来就能起。

## 2. 准备 NapCat

1. 按 [NapCat 官方文档](https://napcat.napcat.wiki/) 装好并登录一个 **QQ 小号**（风控提示见主 README「已知限制」第 2 条）。
2. 在 NapCat 里开启**正向 WebSocket**，默认端口 `3001`。
3. 记下地址（形如 `ws://127.0.0.1:3001`）和 token——如果设了 token，要填进下一步的配置里。

## 3. 准备 requirement-spec skill

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

## 4. 建 qqbot profile

仓库里的 `profiles/qqbot` 是从 headless 派生的模板，复制到 dsh 的 profile 目录：

```bash
cd ~/Documents/ChatGPT/qq-requirement-bot
cp -R profiles/qqbot ~/.dsh/profiles/qqbot
```

## 5. 写配置

```bash
cp bot.config.example.json bot.config.json
$EDITOR bot.config.json
```

**必改的只有 `projectDir`**（需求落在哪个项目里）。群号不用填——bot 连上 NapCat 后会自己报出它所在的群，你把它拉进哪个群，它就在哪个群工作。

其余字段（限流、心跳、上传白名单、群策略、superAdmin）都有合理默认值，含义见主 README 的「配置说明」。

## 6. 自检

```bash
node src/doctor.js            # 配置 / 密钥 / skill / dsh / OneBot 连通性
node src/doctor.js --turn     # 额外真跑一个回合（会消耗 token）
```

第一项全绿再往下走。`--turn` 是可选的重度自检，会真的起一次 dsh 回合。

## 7. 启动

```bash
node src/index.js             # 前台跑，日志直接打屏
```

常驻管理面板另开一个终端：

```bash
./start-panel.sh              # 默认 http://127.0.0.1:7879/console
```

## 8. 验证

把 bot 拉进群（或确认它已在群里），群里 @ 它说一句：

```
@产品同学 首页加个欢迎弹窗，手动批准
```

收到「收到，开始处理」之类的回执就算通了。

## 常见问题

| 现象 | 去哪看 |
| --- | --- |
| 启动但群里没反应 | 主 README「排错」：先查 `bot.qq` 与 `frame.self_id` 是否一致 |
| `MISSING_CREDENTIAL` | 密钥没被读到，重新 `export` 或在 DSH Web GUI 的 Models 页保存 |
| 连不上 ws | NapCat 的正向 WS 没开，或端口/token 不对 |
| 找不到 skill | 跑 `node src/doctor.js`，它会打印尝试过的全部路径 |
