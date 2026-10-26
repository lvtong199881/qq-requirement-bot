#!/usr/bin/env bash
#
# 一键安装：把能自动化的部分全做掉，只留必须人工的步骤。
#
#   ./install.sh                      交互式，会问你项目目录和 QQ 号
#   ./install.sh --project-dir ~/x    指定项目目录，不再问
#   ./install.sh -y                   全部用默认值，不问任何问题
#   ./install.sh --no-napcat          不管 NapCat，跳过第 4 步
#   ./install.sh --skip-doctor        跳过最后的自检
#
# 脚本是幂等的：已经配好的东西会跳过，随时可以重跑。
set -euo pipefail
cd "$(dirname "$0")"

PROJECT_DIR=""
QQ=""
ASSUME_YES=0
SKIP_DOCTOR=0
SKIP_NAPCAT=0

usage() {
  sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    --qq) QQ="${2:-}"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --skip-doctor) SKIP_DOCTOR=1; shift ;;
    --no-napcat) SKIP_NAPCAT=1; shift ;;
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
ask() { printf '  %s [y/N] ' "$1"; read -r _ans; [ "${_ans:-n}" = y ] || [ "${_ans:-n}" = Y ]; }

# 端口探测：连通退出 0
port_open() {
  PORT="$1" node --input-type=module -e '
    import { connect } from "node:net"
    const s = connect({ host: "127.0.0.1", port: Number(process.env.PORT) })
    s.setTimeout(1200)
    const done = (c) => { s.destroy(); process.exit(c) }
    s.on("connect", () => done(0))
    s.on("timeout", () => done(1))
    s.on("error", () => done(1))
  ' 2>/dev/null
}

# ── 1. 环境检查 ─────────────────────────────────────────────────────
step '1/6 检查运行环境'

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$NODE_MAJOR" -ge 22 ]; then
    ok "Node $(node -v)（需要 ≥ 22，自带 WebSocket）"
  else
    fail "Node $(node -v) 太旧，需要 ≥ 22（内置 WebSocket 与 fetch）"
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

# requirement-spec skill：复用 config.js 的探测逻辑，不重写一套
if skill_dir=$(node --input-type=module -e '
  import { resolveSkillDir } from "./src/config.js"
  try { console.log(resolveSkillDir()) } catch { process.exit(1) }
' 2>/dev/null); then
  ok "skill：$skill_dir"
else
  fail '找不到 requirement-spec skill（放在 ~/.agents/skills/ 或 ~/.dsh/skills/ 下，或设 QQ_RS_SKILL_ROOT）'
fi

# ── 2. profile ──────────────────────────────────────────────────────
step '2/6 安装 qqbot profile'
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
step '3/6 生成 bot.config.json'

if [ -f bot.config.json ]; then
  warn '已存在，跳过（不覆盖已有配置）'
  dim '想重来：mv bot.config.json bot.config.json.bak 后再跑'
else
  cp bot.config.example.json bot.config.json

  if [ -z "$PROJECT_DIR" ]; then
    DEFAULT_DIR=$(node -p 'require("./bot.config.example.json").projectDir')
    if [ "$ASSUME_YES" -eq 1 ]; then
      PROJECT_DIR="$DEFAULT_DIR"
      dim "项目目录用默认值：$PROJECT_DIR"
    else
      printf '  需求要落在哪个项目目录？[回车用 %s]\n  > ' "$DEFAULT_DIR"
      read -r ANSWER
      PROJECT_DIR="${ANSWER:-$DEFAULT_DIR}"
    fi
  fi

  if [ -z "$QQ" ] && [ "$ASSUME_YES" -eq 0 ]; then
    printf '  你的 QQ 号？写进 superAdmin 好让面板和群权限认你 [可留空]\n  > '
    read -r QQ || true
  fi

  # 用 node 改 JSON，避免依赖 jq，也避免手写 JSON 出错
  PROJECT_DIR="$PROJECT_DIR" QQ="${QQ:-}" node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs"
    const p = "bot.config.json"
    const cfg = JSON.parse(readFileSync(p, "utf8"))
    cfg.projectDir = process.env.PROJECT_DIR
    cfg.superAdmin = process.env.QQ ? [process.env.QQ] : []
    cfg.adminUsers = []
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n")
  '

  ok "已生成 bot.config.json（projectDir=$PROJECT_DIR${QQ:+，superAdmin=$QQ}）"
fi

# ── 4. NapCat ───────────────────────────────────────────────────────
step '4/6 准备 NapCat（OneBot 协议端）'

WS_PORT=$(node -p 'require("./bot.config.json").onebot.ws' 2>/dev/null | sed -E 's#.*:([0-9]+).*#\1#' || echo 3001)
WS_PORT="${WS_PORT:-3001}"
NAPCAT_READY=0

if [ "$SKIP_NAPCAT" -eq 1 ]; then
  warn '已要求跳过（--no-napcat）'
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' | grep -qx napcat; then
    ok 'napcat 容器已运行'
    NAPCAT_READY=1
  elif docker ps -a --format '{{.Names}}' | grep -qx napcat; then
    warn 'napcat 容器存在但没运行，正在启动'
    if docker start napcat >/dev/null 2>&1; then
      ok '已启动'
      NAPCAT_READY=1
    else
      warn '启动失败，手动看：docker start napcat'
    fi
  else
    warn '没有 napcat 容器'
    DO_CREATE=0
    if [ "$ASSUME_YES" -eq 1 ]; then
      DO_CREATE=1
    elif ask '用 Docker 建一个？（拉镜像约 1 GB）'; then
      DO_CREATE=1
    fi
    if [ "$DO_CREATE" -eq 1 ]; then
      NAPCAT_DIR="$HOME/napcat"
      mkdir -p "$NAPCAT_DIR"
      TOKEN=$(node -p 'require("crypto").randomBytes(8).toString("hex")')
      cat > "$NAPCAT_DIR/docker-compose.yml" <<YAML
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      MODE: ws
      WEBUI_TOKEN: $TOKEN
    ports:
      - "127.0.0.1:6099:6099"
      - "127.0.0.1:$WS_PORT:$WS_PORT"
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
YAML
      if (cd "$NAPCAT_DIR" && docker compose up -d >/dev/null 2>&1); then
        ok "已创建并启动（$NAPCAT_DIR）"
        dim "WebUI token：$TOKEN"
        NAPCAT_READY=1
      else
        warn "启动失败，手动看：cd $NAPCAT_DIR && docker compose up -d"
      fi
    else
      warn '跳过。macOS 也可走官方安装器：'
      dim 'https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest'
    fi
  fi
else
  warn '没检测到可用的 Docker'
  dim 'macOS 可走官方安装器（需要图形界面点几下）：'
  dim 'https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest'
fi

if [ "$NAPCAT_READY" -eq 1 ]; then
  if port_open "$WS_PORT"; then
    ok "OneBot 端口 $WS_PORT 已在监听"
  else
    warn "容器在跑，但端口 $WS_PORT 没监听"
    dim '去 NapCat WebUI 里确认「正向 WebSocket」已启用且端口一致'
  fi
fi

# ── 5. 自检 ─────────────────────────────────────────────────────────
step '5/6 自检'
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

# ── 6. 剩下的必须人工 ───────────────────────────────────────────────
step '6/6 自动部分完成，剩下这些只能你来做'

cat <<EOF
  1) 登录 QQ：浏览器打开 NapCat WebUI，用手机 QQ 扫码
       http://127.0.0.1:6099/webui
     （仅首次需要；登录态会存在数据卷里）
  2) 把 bot 拉进你要服务的群（群号不用填进配置，它会自己发现）
  3) 启动并在群里说一句：

       node src/index.js

       @产品同学 首页加个欢迎弹窗，手动批准

  管理面板（可选，另开一个终端）：./start-panel.sh → http://127.0.0.1:7879/console
EOF

if [ "$ERRORS" -gt 0 ]; then
  printf '\n%s有 %d 项前置检查未通过，先修好再启动。%s\n' "$C_ERR" "$ERRORS" "$C_END"
  exit 1
fi

printf '\n%s安装流程结束。%s\n' "$C_OK" "$C_END"
