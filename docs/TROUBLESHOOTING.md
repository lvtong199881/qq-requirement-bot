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
| 找不到 skill | `node src/doctor.js` 会打印尝试过的全部路径 |
| 回合跑完群里只有一句「这个需求跑完了」 | agent 没输出 `[[WAITING]]`/`[[DONE]]`，看 `--verbose` 日志 |
| 回复被截断 | 调大 `limits.chunkChars`，或调 `maxChunksPerTurn` |
| 群文件没收到 | NapCat 的 `upload_group_file` 需要 bot 是群管理或群主 |

## 看日志

- **落盘**：`.logs/bridge-YYYY-MM-DD.log`，按天切分
- **内存**：最近 500 条，面板的「详细信息」弹窗能直接看（最近 200 条）
- **打屏**：`verbose: true` 会输出每个事件和 token 用量

排错时先把 `verbose` 打开，比猜快得多。
