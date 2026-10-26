# 管理面板

> 返回 [README](../README.md)

常驻进程，聚合所有正在运行的 bridge 实例，看状态、下指令。

```bash
./start-panel.sh              # 默认 http://127.0.0.1:7879/console
./start-panel.sh 8899         # 换端口
```

![需求大盘](images/console-board.png)

左侧菜单三项：**需求大盘** / **实例** / **设置**。

**需求大盘**（默认）——每 3 秒轮询，把各实例的群展平成一张表：PID、需求名、
QQ 群名、发起人、当前阶段状态徽章，每行末尾 `⋯` 菜单提供 **终止 / 重启 / 详细信息**。
切到别的菜单会**自动停掉轮询**，切回来自动恢复。

**实例**——每个 bridge 进程一张卡：PID、QQ 昵称与账号、模型、端口、启动时间、
运行时长、内存（RSS / heap）、OneBot 连接状态、profile、群策略、心跳间隔、
回合超时、服务群数、项目目录与工作目录。卡片左上角状态点变红表示该实例不可达。

![实例](images/console-instances.png)

**设置**——三块：

![设置](images/console-settings.png)

- **指令白名单**（可编辑）：填 QQ 号，中英文逗号均可分隔，保存时统一解析、校验、
  去重后写回 `bot.config.json`，并通知所有实例热更新（不用重启）。空值/多个逗号/
  换行都容忍；非法值（非数字、位数不对）会明确报错并拒绝保存。
- **群消息文案**（可编辑）：bot 在群里说的话，共 **40 条**，按「回执（消息 1）/
  阶段播报（消息 2）/ 其他 / 交互提示 / 指令与操作 / 系统通知」六组归类。
  每条独立编辑、独立恢复默认，只列自己可用的变量：
  `{{stage}}` `{{duration}}` `{{stageDone}}` `{{stageStarted}}` `{{reason}}`
  `{{content}}` `{{artifacts}}` `{{target}}` 等。校验拦：空模板、未知占位符、
  超过 2000 字符。留空保存 = 该条回默认。
- **超级管理员**（只读）：不受群角色与白名单限制，任何群都能驱动 bot——但突破的是
  「人」的限制，群本身若被 `excludeGroups` 排除或 `groupPolicy.mode=deny` 关闭，仍不服务。
  只能在 `bot.config.json` 的 `superAdmin` 字段里修改——面板不提供编辑入口，
  避免把自己锁在门外。

详细信息弹窗会显示该进程的完整状态：群 ID、当前模型、端口、发起时间、阶段进度、
当前回合（子进程是否存活、已运行多久）、最近 200 条日志。

## 架构

```
bridge（每个实例）
├── .instances/<pid>.json   启动时注册，退出时删除——面板靠它发现实例
└── 127.0.0.1:7878          /api/summary、/api/status、/api/logs、/api/ping、
                            /api/settings、/api/groups/:id/{stop,restart}

panel（一个进程）
├── 扫描 .instances/        发现所有实例
├── 逐个拉 /api/summary     聚合成列表（只含列表要画的字段）
└── 127.0.0.1:7879          /console 页面 + 转发操作到对应实例
```

面板与 bridge 分离：bridge 崩了面板还活着，能告诉你它崩了。

## API

| 接口 | 说明 |
| --- | --- |
| `GET /api/summary` | 本实例的精简状态，只含列表要画的字段（bridge） |
| `GET /api/status` | 本实例完整状态，含阶段表与最近 50 条事件（bridge） |
| `GET /api/logs?n=100` | 最近日志，`n` 默认 100、上限 1000（bridge） |
| `GET /api/ping` | 存活探测，返回 pid（bridge） |
| `POST /api/settings` | 面板推配置过来时热更新本实例（bridge） |
| `POST /api/groups/:id/stop` | 终止该群当前任务（bridge） |
| `POST /api/groups/:id/restart` | 重启该群任务，先掐断再用「继续」骨架重跑（bridge） |
| `GET /api/instances` | 聚合所有实例的精简状态（panel） |
| `GET /api/instances/:pid` | 单个实例的完整状态，点「详细信息」时才拉（panel） |
| `GET /api/settings` | 读取白名单与群消息文案（panel） |
| `PUT /api/settings` | 保存白名单 / 文案并热更新所有实例（panel） |

**为什么分两个接口**：需求大盘每 3 秒轮询一次，`/api/instances` 若带上每个实例的
最近 50 条事件和阶段表，绝大部分字段页面根本不画。列表走 `/api/summary`，完整状态
留给 `/api/instances/:pid`，只在点开「详细信息」时按需拉一次。

写操作需要 `panel.token` 非空时携带 `x-panel-token`；留空则只依赖「仅监听 127.0.0.1」。

## 日志

按天落盘到 `.logs/bridge-YYYY-MM-DD.log`，同时保留内存中最近 500 条供面板读取。
