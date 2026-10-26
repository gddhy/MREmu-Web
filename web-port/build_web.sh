#!/usr/bin/env bash
# build_web.sh —— MREmu 的 WebAssembly 构建流水线（实测通过：Emscripten 6.0.13 + CMake 3.29 + Ninja）
#
# 产物：web/dist/index.html + MREmu.js + MREmu.wasm，用 serve.py 起服务即可在浏览器运行。
#
# 前置（两种方式任选）：
#   A) emsdk + 系统 cmake/ninja
#      git clone --depth 1 https://github.com/emscripten-core/emsdk.git
#      cd emsdk && python emsdk.py install latest && python emsdk.py activate latest
#   B) emsdk + pip 工具链（本仓库验证用的组合）
#      python -m venv .toolchain
#      .toolchain/Scripts/pip install "cmake==3.29.6" ninja     # Windows
#      .toolchain/bin/pip     install "cmake==3.29.6" ninja     # Linux/macOS
#
# 还需要 MediaTek MRE SDK 的头文件（deps/mresdk 只吃 include/vm*.h）：
#   https://github.com/raspiduino/mre-sdk/releases/download/1.0.0/MRE_SDK_3.0.00.20_Normal_Eng.zip
#   装好后：export MRE_SDK=/c/MRE_SDK   （目录下必须有 include/vmsys.h）
#
# 用法：bash build_web.sh [Release|Debug]

set -euo pipefail

BUILD_TYPE="${1:-Release}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 自动适配两种布局：合并版（web-port 在项目根里） / 开发版（web-port 与 repo 并列）
if [ -f "$HERE/../CMakeLists.txt" ] && [ -d "$HERE/../MREmu" ]; then
  REPO="$HERE/.."
else
  REPO="$HERE/../repo"
fi
OUT="$REPO/out/web-$BUILD_TYPE"
DIST="$HERE/web/dist"
BIN="$REPO/bin"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[ERR] %s\033[0m\n' "$*" >&2; exit 1; }

say "检查工具链"
command -v emcc >/dev/null 2>&1 || die "找不到 emcc。先装 emsdk（见文件头注释）"
command -v emcmake >/dev/null 2>&1 || die "找不到 emcmake"
command -v cmake >/dev/null 2>&1 || die "找不到 cmake（pip 装：pip install \"cmake==3.29.6\" ninja）"
emcc --version 2>/dev/null | head -1

[ -d "$REPO" ] || die "找不到仓库 $REPO（把仓库放到 $HERE/.. 或 $HERE/../repo）"

if [ -z "${MRE_SDK:-}" ]; then
  die "未设置 MRE_SDK 环境变量（deps/mresdk 需要 SDK 头文件，见文件头注释）"
fi
[ -f "$MRE_SDK/include/vmsys.h" ] || die "$MRE_SDK/include 下没有 vmsys.h，SDK 路径不对"

say "同步子模块"
git -C "$REPO" submodule update --init --depth 1 \
    deps/libiconv-cmake deps/libADLMIDI deps/spdlog deps/asio.cmake deps/capstone || true

say "应用 Web 移植补丁（幂等；本合并版已应用，应显示 skip）"
python "$HERE/apply_web_patch.py" --repo "$REPO"

# FetchContent 默认走网络，若本地已 clone 好则直接指过去（省 10 分钟）
EXTRA=()
for pair in "SFML:deps-cache/SFML" "UNICORN:deps-cache/unicorn"; do
  name="${pair%%:*}"; dir="${pair#*:}"
  if [ -f "$HERE/../$dir/CMakeLists.txt" ]; then
    win=$(cygpath -w "$HERE/../$dir" 2>/dev/null || echo "$HERE/../$dir")
    EXTRA+=("-DFETCHCONTENT_SOURCE_DIR_$name=$win")
    echo "使用本地 $name: $win"
  fi
done

# 脱敏：assert/__FILE__ 会把本机绝对路径编进 wasm，这里让它们只留相对路径
WS_WIN=$(cygpath -w "$(cd "$REPO/.." && pwd)" 2>/dev/null || echo "$(cd "$REPO/.." && pwd)")
EXTRA+=("-DMREMU_FILE_PREFIX_MAP=$WS_WIN")
echo "脱敏前缀: $WS_WIN -> ."

say "CMake configure ($BUILD_TYPE)"
emcmake cmake -S "$REPO" -B "$OUT" -G Ninja \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
    -DDEBUG_WINDOW=OFF -DBUILTIN_GDB=OFF -DCAPSTONE=OFF \
    "${EXTRA[@]}"

# 注意：--shell-file 的变更 ninja 不追踪，改过 shell 必须先删旧输出
rm -f "$BIN/MREmu.html" "$BIN/MREmu.js"

say "编译"
cmake --build "$OUT" --parallel "$(nproc 2>/dev/null || echo 4)"

say "收集产物 -> $DIST"
mkdir -p "$DIST"
cp -f "$BIN/MREmu.js" "$BIN/MREmu.wasm" "$DIST/"
cp -f "$BIN/MREmu.html" "$DIST/index.html"
cp -f "$HERE/web/coi-serviceworker.js" "$HERE/web/serve.py" "$HERE/web/404.html" "$DIST/"

# PWA：manifest + 图标（ic_calculator-one 来自字节 IconPark）
cp -f "$HERE/web/manifest.json" "$HERE/web/ic_calculator-one.svg" "$DIST/"
mkdir -p "$DIST/icons"
cp -f "$HERE/web/icons/"*.png "$DIST/icons/" 2>/dev/null || echo "  (icons/*.png 不存在，先跑: node tools/gen_icons.js)"

say "完成"
cat <<EOF
本地跑起来：
    cd "$DIST" && python serve.py 8080
浏览器打开 http://localhost:8080/ ，把 .vxp 拖进页面即可。

实测注意：
  * 必须用带 COOP/COEP 头的服务器（serve.py 已带），否则没有 SharedArrayBuffer。
  * MRE SDK 3.0.00.03（中文版）缺 vm_get_volume 声明，补丁已放进 deps/mresdk/vmmissing.h。
  * Emscripten 6 已移除 FS.filesystems，IDBFS 从 Module.IDBFS 取（shell 已处理）。
  * SFML 2.6 的 sf::String 需要 char_traits<unsigned int> 特化，见 web/char_traits_shim.h。
EOF
