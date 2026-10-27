# 排错

> 返回 [README](../README.md)

先跑自检，它会把配置、密钥、skill、dsh、OneBot 连通性一次列出来：

```bash
node src/doctor.js
```

## 常见现象

| 现象 | 排查 |
| --- | --- |
| 启动了但群里没反应 | `bot.qq` 和 `frame.self_id` 是否一致；消息是否真的 @ 了 bot |
| `连不上 ws://…` | NapCat 是否开了正向 WS；端口是否对；token 是否要填 |
| `MISSING_CREDENTIAL` | `export DEEPSEEK_API_KEY=...`，或在 DSH Web GUI 的 Models 页保存 |
| 找不到 skill | 角色卡在仓库的 `skills/<角色>/SKILL.md`，不是全局 skill 目录 |
| `启动 dsh 失败（ENOENT）` | `bot.config.json` 的 `dshBin` 指向真实路径，别只写 `dsh` |
| `文件权限不足（EPERM）` | bridge 在受限环境里跑，dsh 写不了 `~/.dsh`。从普通终端启动 |
| 阶段反复重跑、返工次数一直涨 | agent 没写 `_receipt-<阶段>.json` 或产物没落盘，看 `.logs` 里同阶段的回合记录 |
| 群文件没收到 | NapCat 的 `upload_group_file` 需要 bot 是群管理或群主 |
| 面板显示「旧版需求」 | 那个群绑的是早期版本的需求，v2 不接管，重新提一个就行 |

## 卡在哪一步

状态机把当前进度写在各群的状态文件里：

```bash
cat .state/group-<群号>.json | python3 -m json.tool
```

看 `flow.current`（当前阶段）、`flow.status`（running / waiting_user / blocked / done）、
`flow.rounds`（各阶段返工次数）。编排记录 `docs/requirements/<需求ID>/编排记录.md`
是同一份状态的易读版本。

## 回合卡住不退出

dsh 子进程可能挂住不退出（工具调用超时、等网络）。表现是日志停在 `v2 回合：<阶段>`，
会话文件的修改时间不再变化。处理办法：

```bash
kill <bridge PID>    # 子进程会一起退
node src/index.js    # 重启后该群停在 running，发「继续」重跑当前阶段
```

**不要**直接删 `.state/`——那会丢进度。

## 看日志

- **落盘**：`.logs/bridge-YYYY-MM-DD.log`，按天切分（UTC 日期）
- **内存**：最近 500 条，面板的「详细信息」弹窗能直接看
- **打屏**：`verbose: true` 会输出每个事件和 token 用量

排错时先把 `verbose` 打开，比猜快得多。
