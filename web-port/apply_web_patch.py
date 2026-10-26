#!/usr/bin/env python3
"""
apply_web_patch.py —— 给 MREmu 仓库打上 Web(Emscripten) 移植补丁。

做法（比锚点替换更可靠）：
  1. patches/0001-mremu-web-port.patch —— 对已跟踪文件的修改（git diff 导出）
  2. patches/overlay/                  —— 新增文件（WebBridge.cpp、shell、兼容头等）

幂等：若 repo/web/shell.html 已存在则认为已打过，跳过。
回滚：python apply_web_patch.py --revert

用法：
    python apply_web_patch.py                 # 默认项目根（web-port 的上一级）
    python apply_web_patch.py --repo <path>
"""

import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PATCH = os.path.join(HERE, "patches", "0001-mremu-web-port.patch")
OVERLAY = os.path.join(HERE, "patches", "overlay")

OVERLAY_FILES = {
    "WebBridge.cpp": os.path.join("MREmu", "WebBridge.cpp"),
    "shell.html": os.path.join("web", "shell.html"),
    "char_traits_shim.h": os.path.join("web", "char_traits_shim.h"),
    "coi-serviceworker.js": os.path.join("web", "coi-serviceworker.js"),
    "404.html": os.path.join("web", "404.html"),
    "serve.py": os.path.join("web", "serve.py"),
    "manifest.json": os.path.join("web", "manifest.json"),
    "ic_calculator-one.svg": os.path.join("web", "ic_calculator-one.svg"),
    "icons/icon-512.png": os.path.join("web", "icons", "icon-512.png"),
    "icons/icon-192.png": os.path.join("web", "icons", "icon-192.png"),
}

# 旧版锚点式补丁的遗留标记：出现过说明是老补丁打过的，先还原再上新补丁
OLD_MARK = "MREMU_WEB_PATCH"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=None)
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    repo = args.repo or os.path.normpath(os.path.join(HERE, ".."))   # 合并版：项目根即仓库
    if not os.path.isdir(repo):
        sys.exit("找不到仓库目录: %s" % repo)

    git = ["git", "-C", repo]

    if args.revert:
        subprocess.check_call(git + ["checkout", "--", "."])
        for src, rel in OVERLAY_FILES.items():
            p = os.path.join(repo, rel)
            if os.path.isfile(p):
                os.remove(p)
                print("removed", rel)
        print("已还原。")
        return

    marker = os.path.join(repo, "web", "shell.html")
    if os.path.isfile(marker):
        print("看起来已经打过补丁（存在 %s），跳过。" % os.path.relpath(marker, repo))
        return

    # 老版本补丁留下的痕迹要先清掉，避免 git apply 冲突
    diff = subprocess.check_output(git + ["diff", "--name-only"], text=True)
    if OLD_MARK in open(os.path.join(repo, "CMakeLists.txt"), encoding="utf-8", errors="ignore").read():
        print("检测到旧版补丁痕迹，先 git checkout 还原已跟踪文件...")
        subprocess.check_call(git + ["checkout", "--", "."])

    # 1) 覆盖新增文件
    for src, rel in OVERLAY_FILES.items():
        dst = os.path.join(repo, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(OVERLAY, src), dst)
        print("copy  ", rel)

    # 2) 应用对已跟踪文件的修改
    subprocess.check_call(git + ["apply", "--whitespace=nowarn", os.path.abspath(PATCH)])
    print("apply ", os.path.basename(PATCH))

    print("\n--- git diff --stat ---")
    subprocess.call(git + ["diff", "--stat"])
    print("\n新增文件（未跟踪）：MREmu/WebBridge.cpp web/*")
    print("下一步：bash build_web.sh")


if __name__ == "__main__":
    main()
