#!/usr/bin/env bash
#
# 把鸿蒙工具链从 DevEco Studio 里抽出来，装到独立目录。
#
# 为什么这么做：DevEco 完整装是 11 GB（IDE 本体 + JBR + plugins 占大头），
# 但真正干活只需要三样——SDK、模拟器、hvigor。抽出来约 6 GB，
# 而且可以在没有图形界面的机器（CI、服务器）上跑。
#
# 实测结论（2026-10-28）：
#   - 编译：npm 装 @ohos/hvigor + SDK 路径即可，BUILD SUCCESSFUL in 11s
#   - 单测：同上，9s 通过（比 DevEco 的 hvigorw 还快，那个会卡 daemon）
#   - 模拟器：emulator 目录整个复制即可，rpath 全是 @loader_path 相对路径
#   - SDK：官方没有独立下载，只能从 DevEco 里复制（这是唯一还依赖它的地方）
#
# 用法：
#   scripts/setup-ohos-toolchain.sh                       # 从默认 DevEco 路径抽取
#   scripts/setup-ohos-toolchain.sh --from /path/to/DevEco-Studio.app
#   scripts/setup-ohos-toolchain.sh --target ~/ohos-toolchain
#   scripts/setup-ohos-toolchain.sh --link-sdk            # SDK 用软链，省 5.5G（但 DevEco 必须留着）
#   scripts/setup-ohos-toolchain.sh --skip-emulator       # 只要编译环境，不要模拟器
#
set -euo pipefail

DEVECO_DEFAULT="/Applications/DevEco-Studio.app"
TARGET_DEFAULT="$HOME/ohos-toolchain"
NPM_REGISTRY="https://repo.harmonyos.com/npm/"

DEVECO="$DEVECO_DEFAULT"
TARGET="$TARGET_DEFAULT"
LINK_SDK=0
SKIP_EMULATOR=0
SKIP_HVIGOR=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from)          DEVECO="$2"; shift 2 ;;
    --target)        TARGET="$2"; shift 2 ;;
    --link-sdk)      LINK_SDK=1; shift ;;
    --skip-emulator) SKIP_EMULATOR=1; shift ;;
    --skip-hvigor)   SKIP_HVIGOR=1; shift ;;
    -h|--help)       sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m[toolchain]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[toolchain] %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$DEVECO" ] || die "找不到 DevEco：$DEVECO（用 --from 指定）"
[ -d "$DEVECO/Contents/sdk" ] || die "$DEVECO 里没有 Contents/sdk，装的是精简版？"

mkdir -p "$TARGET"

# ── 1. SDK ──────────────────────────────────────────────
SDK_SRC="$DEVECO/Contents/sdk"
SDK_DST="$TARGET/sdk"
if [ -e "$SDK_DST" ]; then
  say "SDK 已存在，跳过：$SDK_DST"
elif [ "$LINK_SDK" = "1" ]; then
  say "软链 SDK（省空间，但 DevEco 不能删）：$SDK_SRC → $SDK_DST"
  ln -s "$SDK_SRC" "$SDK_DST"
else
  say "复制 SDK（约 5.5 GB，慢一点）…"
  cp -R "$SDK_SRC" "$SDK_DST"
fi

# ── 2. 模拟器 ────────────────────────────────────────────
if [ "$SKIP_EMULATOR" = "1" ]; then
  say "跳过模拟器"
else
  EMU_SRC="$DEVECO/Contents/tools/emulator"
  EMU_DST="$TARGET/emulator"
  if [ -d "$EMU_DST" ]; then
    say "模拟器已存在，跳过：$EMU_DST"
  elif [ -d "$EMU_SRC" ]; then
    say "复制模拟器（约 203 MB）…"
    cp -R "$EMU_SRC" "$EMU_DST"
    # 二进制用 @loader_path 找 Qt 库，整目录复制就能独立跑
    [ -x "$EMU_DST/Emulator" ] || die "复制后 Emulator 不可执行"
  else
    say "DevEco 里没有 emulator 目录，跳过"
  fi
fi

# ── 3. hvigor（编译 + 单测） ─────────────────────────────
if [ "$SKIP_HVIGOR" = "1" ]; then
  say "跳过 hvigor"
else
  if [ -f "$TARGET/node_modules/@ohos/hvigor/package.json" ]; then
    say "hvigor 已存在，跳过"
  else
    say "从华为仓库安装 hvigor（公开可装，不需要 DevEco）…"
    ( cd "$TARGET" && [ -f package.json ] || npm init -y >/dev/null 2>&1
      # 公开 npmjs 上没有这个包，只有华为自己的仓库有
      npm install --registry="$NPM_REGISTRY" \
        @ohos/hvigor @ohos/hvigor-ohos-plugin 2>&1 | tail -3 )
  fi
fi

# ── 4. 环境脚本 ──────────────────────────────────────────
ENV_FILE="$TARGET/env.sh"
cat > "$ENV_FILE" <<ENVEOF
# 由 scripts/setup-ohos-toolchain.sh 生成
# 用法：source $ENV_FILE
export OHOS_TOOLCHAIN="$TARGET"
export DEVECO_SDK_HOME="$TARGET/sdk"
# hvigorfile.ts 里 import 的 @ohos/hvigor-ohos-plugin 靠 NODE_PATH 找到
export NODE_PATH="$TARGET/node_modules\${NODE_PATH:+:\$NODE_PATH}"
ENVEOF
say "环境脚本：$ENV_FILE"

# ── 5. 自检 ──────────────────────────────────────────────
echo
say "自检："
if [ -d "$SDK_DST/default" ] || [ -d "$SDK_DST/HarmonyOS-26.0.0" ]; then
  VER=$(python3 - "$SDK_DST" <<'PY' 2>/dev/null || true
import json,sys,os,glob
for p in glob.glob(os.path.join(sys.argv[1],'*/sdk-pkg.json')):
    try:
        d=json.load(open(p))['data']
        print(d.get('displayName'), d.get('version'))
        break
    except Exception: pass
PY
)
  say "  SDK：${VER:-已就位}  ($SDK_DST)"
else
  say "  SDK：目录存在但没看到平台版本，检查一下 $SDK_DST"
fi

if [ -f "$TARGET/node_modules/@ohos/hvigor/package.json" ]; then
  HV=$(python3 -c "import json;print(json.load(open('$TARGET/node_modules/@ohos/hvigor/package.json'))['version'])" 2>/dev/null || echo "?")
  say "  hvigor：$HV"
fi

if [ -x "$TARGET/emulator/Emulator" ]; then
  N=$("$TARGET/emulator/Emulator" -list 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  say "  emulator：可用，已配置 $N 台模拟器"
fi

cat <<TIPEOF

下一步：
  source $ENV_FILE
  cd <鸿蒙工程目录>
  node \$OHOS_TOOLCHAIN/node_modules/@ohos/hvigor/bin/hvigor.js \\
    --mode module -p module=entry@default assembleHap --no-daemon

提示：hvigor 的 daemon 在有些机器上会卡住（实测这台就是），一定要带 --no-daemon。

说明：SDK 目前只能从 DevEco 复制——官方没有独立的 SDK 下载入口。
      IDE 本体（plugins 2.5G / lib 778M / jbr 442M）不需要，本脚本没动它们。
TIPEOF
