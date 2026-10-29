#!/usr/bin/env bash
#
# 启动三个常驻进程（模拟器服务 / bridge / 面板）。
#
# 为什么用 setsid：它们以前是从 dsh 的 shell 里 nohup 起来的，
# 重启 dsh 会把整个进程组带走——实测重启一次，跑了一半的 dev 回合直接没了。
# setsid 让它们脱离会话，成为独立的进程组长，和谁启动的无关。
#
# 用法：
#   scripts/start-all.sh           # 启动（已在跑就跳过）
#   scripts/start-all.sh --restart # 先停再启动
#
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
mkdir -p .logs
REPO_ROOT="$(pwd)"

RESTART=0
[ "${1:-}" = "--restart" ] && RESTART=1

stop_all() {
  # 只查 7878/7879/7880 是不够的：实例漂到 7881、7882 之后就杀不到，
  # 下次启动又占不到 7878，结果越积越多，多个进程同时连 QQ。
  # 按进程名和实例注册表一起收。
  local killed=0 pid

  for port in 7878 7879 7880; do
    pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -1 | awk '{print $2}')
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null && { echo "  停止端口 ${port}（PID ${pid}）"; killed=1; }
    fi
  done

  # 注册表里登记过、但端口漂走的
  if [ -d "$REPO_ROOT/.instances" ]; then
    for f in "$REPO_ROOT"/.instances/*.json; do
      [ -e "$f" ] || continue
      pid=$(basename "$f" .json)
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && { echo "  停止漂移实例（PID ${pid}）"; killed=1; }
      fi
      rm -f "$f"
    done
  fi

  # 兜底：还在跑的 bridge 进程
  for pid in $(pgrep -f "node .*src/index\.js" 2>/dev/null); do
    kill "$pid" 2>/dev/null && { echo "  停止残留 bridge（PID ${pid}）"; killed=1; }
  done

  [ "$killed" = "1" ] && sleep 2
  return 0
}

start_one() {
  local name=$1 port=$2 entry=$3
  local pid
  pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -1 | awk '{print $2}')
  if [ -n "$pid" ] && [ "$RESTART" = "0" ]; then
    echo "  端口 ${port} 已在运行（PID ${pid}），跳过 ${name}"
    return
  fi
  # macOS 没有 setsid，用 node 的 detached 起（子进程成为新进程组组长，
  # 和谁启动它无关）。实测 nohup 不够——重启 dsh 会把整个进程组带走。
  node -e '
    const { spawn } = require("node:child_process")
    const fs = require("node:fs")
    const out = fs.openSync(process.argv[2], "a")
    const c = spawn("node", [process.argv[1]], {
      detached: true, stdio: ["ignore", out, out],
    })
    c.unref()
  ' "$entry" ".logs/$name-stdout.log"
  sleep 3
  pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -1 | awk '{print $2}')
  if [ -n "$pid" ]; then
    echo "  ✅ ${name} → 端口 ${port}（PID ${pid}）"
  else
    echo "  ❌ ${name} 没起来，看 .logs/${name}-stdout.log"
  fi
}

[ "$RESTART" = "1" ] && stop_all

start_one emulator 7880 src/emulator-service.js
start_one bridge 7878 src/index.js
start_one panel 7879 src/ui/panel.js

echo
echo "面板：http://127.0.0.1:7879/console"
