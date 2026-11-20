#!/usr/bin/env bash
#
# 一键安装：把能自动化的部分全做掉，只留必须人工的步骤。
#
#   ./install.sh                      交互式，会问你项目目录
#   ./install.sh --project-dir ~/x    指定项目目录，不再问
#   ./install.sh -y                   全部用默认值，不问任何问题
#   ./install.sh --skip-doctor        跳过最后的自检
#
# 脚本是幂等的：已经配好的东西会跳过，随时可以重跑。
set -euo pipefail
cd "$(dirname "$0")"

PROJECT_DIR=""
ASSUME_YES=0
SKIP_DOCTOR=0

usage() {
  sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --skip-doctor) SKIP_DOCTOR=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

# ── 输出 ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_STEP=$'\033[36m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
else
  C_OK=''; C_ERR=''; C_WARN=''; C_STEP=''; C_DIM=''; C_END=''
fi
step() { printf '\n%s▸ %s%s\n' "$C_STEP" "$1" "$C_END"; }
ok()   { printf '  %s✅%s %s\n' "$C_OK" "$C_END" "$1"; }
warn() { printf '  %s⚠️ %s%s\n' "$C_WARN" "$1" "$C_END"; }
bad()  { printf '  %s❌ %s%s\n' "$C_ERR" "$1" "$C_END"; }
dim()  { printf '  %s%s%s\n' "$C_DIM" "$1" "$C_END"; }

ERRORS=0
fail() { bad "$1"; ERRORS=$((ERRORS + 1)); }

# ── 1. 环境检查 ─────────────────────────────────────────────────────
step '1/5 检查运行环境'

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$NODE_MAJOR" -ge 22 ]; then
    ok "Node $(node -v)（需要 ≥ 22）"
  else
    fail "Node $(node -v) 太旧，需要 ≥ 22（内置 fetch）"
  fi
else
  fail '找不到 node，先装 Node ≥ 22'
fi

if command -v dsh >/dev/null 2>&1; then
  ok "dsh 可用（$(command -v dsh)）"
else
  fail 'PATH 里没有 dsh，先装 DeepSeek Harness'
fi

# DEEPSEEK_API_KEY：环境变量优先，其次 ~/.dsh/.credentials.yaml
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  ok 'DEEPSEEK_API_KEY 已在环境变量里'
elif [ -f "$HOME/.dsh/.credentials.yaml" ] && grep -q 'DEEPSEEK_API_KEY' "$HOME/.dsh/.credentials.yaml" 2>/dev/null; then
  ok 'DEEPSEEK_API_KEY 在 ~/.dsh/.credentials.yaml 里'
else
  fail '找不到 DEEPSEEK_API_KEY：export 一下，或在 DSH Web GUI 的 Models 页保存'
fi

# ── 2. profile ──────────────────────────────────────────────────────
step '2/5 安装 qqbot profile'
PROFILE_DST="$HOME/.dsh/profiles/qqbot"
if [ -d "$PROFILE_DST" ]; then
  warn "已存在，跳过：$PROFILE_DST"
  dim '要覆盖就手动 rm -rf 后再跑一次（会丢失该 profile 的本地改动）'
else
  mkdir -p "$HOME/.dsh/profiles"
  cp -R profiles/qqbot "$PROFILE_DST"
  ok "已复制到 $PROFILE_DST"
fi

# ── 3. 配置 ─────────────────────────────────────────────────────────
step '3/5 生成 bot.config.json'

if [ -f bot.config.json ]; then
  warn '已存在，跳过（不覆盖已有配置）'
  dim '想重来：mv bot.config.json bot.config.json.bak 后再跑'
  # 老配置可能是 QQ 时代的（没有 api 段），补上就不用用户自己翻文档
  if ! node -e 'const c=require("./bot.config.json"); process.exit(c.api ? 0 : 1)' 2>/dev/null; then
    node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs"
      const p = "bot.config.json"
      const cfg = JSON.parse(readFileSync(p, "utf8"))
      cfg.api = { enabled: true, port: 7881, host: "0.0.0.0", allowedOrigin: "", maxBodyBytes: 1000000 }
      writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n")
    '
    ok '补上了 api 段（App 要靠它连进来）'
  fi
else
  cp bot.config.example.json bot.config.json

  if [ -z "$PROJECT_DIR" ]; then
    DEFAULT_DIR=$(node -p 'require("./bot.config.example.json").repos[0].path')
    if [ "$ASSUME_YES" -eq 1 ]; then
      PROJECT_DIR="$DEFAULT_DIR"
      dim "项目目录用默认值：$PROJECT_DIR"
    else
      printf '  需求要落在哪个项目目录？[回车用 %s]\n  > ' "$DEFAULT_DIR"
      read -r ANSWER
      PROJECT_DIR="${ANSWER:-$DEFAULT_DIR}"
    fi
  fi

  # 用 node 改 JSON，避免依赖 jq，也避免手写 JSON 出错
  PROJECT_DIR="$PROJECT_DIR" node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs"
    import { basename } from "node:path"
    const p = "bot.config.json"
    const cfg = JSON.parse(readFileSync(p, "utf8"))
    cfg.repos = [{ id: "app", name: basename(process.env.PROJECT_DIR), path: process.env.PROJECT_DIR }]
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n")
  '

  ok "已生成 bot.config.json（repo=$PROJECT_DIR）"
fi

API_PORT=$(node -p 'require("./bot.config.json").api?.port ?? 7881' 2>/dev/null || echo 7881)

# ── 4. 自检 ─────────────────────────────────────────────────────────
step '4/5 自检'
if [ "$SKIP_DOCTOR" -eq 1 ]; then
  warn '已要求跳过（--skip-doctor）'
  dim '稍后手动跑：node src/doctor.js'
elif [ "$ERRORS" -gt 0 ]; then
  warn "前置检查有 $ERRORS 项没过，先修好再跑自检"
  dim '修好后执行：node src/doctor.js'
else
  if node src/doctor.js; then
    ok 'doctor 通过'
  else
    warn 'doctor 有未通过项，按上面的提示修（常见项见 docs/TROUBLESHOOTING.md）'
  fi
fi

# ── 5. 剩下的必须人工 ───────────────────────────────────────────────
step '5/5 自动部分完成，剩下这些只能你来做'

cat <<EOF
  1) 启动服务：

       node src/index.js

  2) 用 App 连上它，地址填：

       http://127.0.0.1:${API_PORT}

     手机和这台机器在同一个 Wi-Fi 时，填本机内网 IP（macOS 下用
     \`ipconfig getifaddr en0\` 查），如 http://192.168.1.5:${API_PORT}

  3) 第一个注册的账号自动成为系统管理员，之后：
     - 管理员能发起需求、点「通过/打回」、管账号
     - 普通成员能看需求和发言，但通过/打回会提示只有管理员能操作

  管理面板（可选，另开一个终端）：./start-panel.sh → http://127.0.0.1:7879/console
EOF

if [ "$ERRORS" -gt 0 ]; then
  printf '\n%s有 %d 项前置检查未通过，先修好再启动。%s\n' "$C_ERR" "$ERRORS" "$C_END"
  exit 1
fi

printf '\n%s安装流程结束。%s\n' "$C_OK" "$C_END"
