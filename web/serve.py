#!/usr/bin/env python3
"""
MREmu Web 本地调试服务器（只用标准库）。

它做的事情很少但很关键：给所有响应加上 COOP/COEP 头。
pthreads 版 wasm 依赖 SharedArrayBuffer，而 SharedArrayBuffer 只在
"跨源隔离"(crossOriginIsolated == true) 的页面里可用，这要求：

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

用法：
    python serve.py                 # 服务当前目录，端口 8080
    python serve.py 9000 web/dist   # 指定端口和目录
"""

import functools
import http.server
import os
import socketserver
import sys

COOP = "same-origin"
COEP = "require-corp"
CORP = "cross-origin"

EXTRA_TYPES = {
    ".wasm": "application/wasm",
    ".data": "application/octet-stream",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".vxp": "application/octet-stream",
    ".webmanifest": "application/manifest+json",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", COOP)
        self.send_header("Cross-Origin-Embedder-Policy", COEP)
        self.send_header("Cross-Origin-Resource-Policy", CORP)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # 精简日志：只打 4xx/5xx 和 .wasm/.data 请求
        code = args[1] if len(args) > 1 else ""
        msg = fmt % args
        if str(code).startswith(("4", "5")) or ".wasm" in msg or ".data" in msg:
            sys.stderr.write("  %s\n" % msg)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    root = sys.argv[2] if len(sys.argv) > 2 else "."
    root = os.path.abspath(root)

    if not os.path.isdir(root):
        sys.exit("目录不存在: %s" % root)

    handler = functools.partial(Handler, directory=root)
    with Server(("", port), handler) as httpd:
        print("MREmu Web  ->  http://localhost:%d/   (root=%s)" % (port, root))
        print("COOP=%s  COEP=%s  —— 打开页面后 console 里 crossOriginIsolated 应为 true" % (COOP, COEP))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")


if __name__ == "__main__":
    main()
