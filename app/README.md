# 需求 App（Flutter）

需求全流程的移动端壳：看需求、拍板、打回。后端是仓库根目录的 `qq-requirement-bot`
（`api.enabled = true` 后对外提供 `/api/*`）。

不做通用 IM，只有三页：

```
连接服务器 → 登录/注册 → 需求列表 → 需求详情
                                    ├─ 阶段进度条
                                    ├─ 消息流（播报 + 我发的话）
                                    └─ 通过 / 打回 / 输入框
             管理员 ──→ 账号管理（改角色 / 停用 / 重置密码）
```

账号管理是管理员的第四页，入口在列表页右上角的「我的」里。加它是因为注册
流程故意不做邮箱和找回密码——那些能力必须有个地方落地，否则「忘了密码找
管理员重置」只是一句话。

## 跑起来

```bash
export PATH="$HOME/flutter/bin:$PATH"     # 本机 Flutter 不在 PATH 里
cd app

# 桌面调试（最快，不用手机）
flutter run -d macos

# 手机
flutter run -d <device-id>                # flutter devices 看设备
```

后端要先开 App API：

```json
"api": { "enabled": true, "port": 7881, "host": "0.0.0.0" }
```

启动日志会打印实际地址。真机连的时候别填 `127.0.0.1`——那是手机自己。

## 连本地后端

| 场景 | 填什么 |
| --- | --- |
| 桌面版 | `http://127.0.0.1:7881` |
| 手机 + 同一 Wi-Fi | `http://<Mac 的局域网 IP>:7881`（`ipconfig getifaddr en0`） |
| 公网 | `https://<你的域名>`（Cloudflare Tunnel，见 `../docs/CONFIG.md`） |

不带协议也行，会按 `http` 处理——自建服务通常没证书，猜 `https` 只会让第一次配置必然失败。

第一个注册的人自动成为系统管理员。之后注册的都是普通成员：能看需求、能发言，
但点「通过/打回」会被后端拒（`403`），App 会把后端那句话原样弹出来。
这是刻意的——按需求，按钮不藏，点了才告诉他权限不够。

## 测试

```bash
flutter analyze          # 静态检查，必须零 issue
flutter test             # 单元测试（不需要后端）

# 打真后端验契约（后端要在跑）
dart run tool/smoke.dart http://127.0.0.1:7881 用户名 密码
```

`tool/smoke.dart` 走完整链路：登录 → me → 列表 → 建需求 → 拉消息 → 增量 →
发消息 → 通过/打回。带普通成员账号跑也能过（会自动跳过只能管理员做的事）。
单独放 `tool/` 而不是 `test/`，是因为它依赖外部进程，放进去会让 `flutter test` 随机红。

## 结构

```
lib/
  api/          client（HTTP + 错误映射）· models（容错解析）· credentials（secure storage）
  state/        auth（会话状态机）· threads（列表 + 5s 轮询）· detail（详情 + 3s 增量轮询）
  ui/           四页（含账号管理）+ theme/format/widgets
test/           api_test · auth_test · users_page_test · widget_test
tool/smoke.dart 打真后端的契约冒烟
```

## 几个刻意的取舍

- **轮询，不用 WebSocket**。用户明确说不需要推送，打开 App 才看。5 秒/3 秒一次的
  GET 在团队规模下开销可忽略，省掉长连接的重连、心跳、断线补拉一整套——那才是
  真正容易出错的地方。
- **不做未读数红点**。一个数字只增加解释成本。用「等你确认」置顶代替。
- **不在前端硬编码权限**。按钮置灰的依据是 `/api/auth/me` 返回的 `perms`，
  权限规则将来只改后端。
- **状态管理手写 ChangeNotifier**。三个 controller、没有复杂依赖关系，
  引 riverpod/bloc 是给自己加一层要学的东西。
- **只有三个直接依赖**。下载文件用 `Directory.systemTemp` + 复制路径，
  不引 path_provider/share_plus。
- **消息不做本地乐观插入**。要做文本去重，后端改措辞就会出现重影。
