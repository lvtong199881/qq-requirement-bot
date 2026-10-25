#!/usr/bin/env bash
# 启动管理面板（常驻）：聚合所有 bridge 实例，页面在 /console。
# 用法：./start-panel.sh [端口]
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-${PANEL_PORT:-}}"
if [ -n "$PORT" ]; then
  PANEL_PORT="$PORT" exec node src/panel.js
fi
exec node src/panel.js
