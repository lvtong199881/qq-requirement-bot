#!/usr/bin/env bash
# 启动 bridge：自动补 DEEPSEEK_API_KEY，然后用 node 跑。
# 用法：./start.sh [--config=path]
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$HOME/.dsh/.credentials.yaml" ]; then
  DEEPSEEK_API_KEY=$(awk '/^refs:/{f=1;next} f&&/^[^ ]/{exit} f&&/DEEPSEEK_API_KEY:/{sub(/^[^:]*:[[:space:]]*/,"");gsub(/["'"'"']/,"");print;exit}' "$HOME/.dsh/.credentials.yaml")
  export DEEPSEEK_API_KEY
fi

exec node src/index.js "$@"
