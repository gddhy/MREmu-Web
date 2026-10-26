# edge-relay —— MREmu 的边缘 TCP 转发（Cloudflare Workers）

回答"web 页面 → edge function → 出站 TCP → 回传 web"这条路是否可行：
**可行，但有明确的平台边界**（TCP 可以，UDP 不行），详见方案文档 §8.3。

## 各边缘平台可行性

| 平台 | WS 服务端 | 出站 TCP | 出站 UDP | 结论 |
|---|---|---|---|---|
| **Cloudflare Workers** | ✅ | ✅ `cloudflare:sockets` 的 `connect()` | ❌ | **推荐**，本目录就是它的实现 |
| Deno Deploy | ✅ | ✅ `Deno.connect` | ❌（Deploy 无 UDP） | 可行，需把 worker.js 改写成 Deno 风格 |
| Vercel Edge Functions | ❌（纯 request/response） | ❌ | ❌ | 不可行（Node 运行时 + Fluid 可讨论，但已不算 edge） |
| Fastly Compute | ✅ | ❌（出站受限） | ❌ | 不可行 |
| 自建 VPS + websockify | ✅ | ✅ | ✅（可加 UDP 中继） | 功能最全，但要自己运维 |

## 协议

不用 websockify（Emscripten 的 `PROXY_POSIX_SOCKETS` 走的是"POSIX 系统调用桥"
协议，见 `emscripten/tools/websocket_to_posix_proxy/`，把整个 socket()/connect()/send()/recv()
编码成消息过 WS——在 Worker 里复刻一遍成本高）。

本目录用的是**更轻的自定义协议**，配合在模拟器侧
`TcpSock::connect`（`MREmu/MREngine/Sock.cpp`）里做 URL 重写（见文档 §8.3 路线 B）：

```
浏览器 → Worker：第一条 binary 消息 = [0x01][port:2B 大端][host...]
Worker → 浏览器：[0x02] 表示 TCP 已建立，之后双向 binary 消息 = TCP 字节流
```

每个 `vm_tcp_connect` 对应一条 WebSocket 连接（一个 Worker 实例只背一条 TCP），
`vm_tcp_close` 对应 WS close。MRE 的事件模型（CONNECTED / PIPE_BROKEN）与
`TcpSock::push_event` 的对接方式见方案文档 §8.3 的路线 B 代码骨架。

## 部署

```bash
npm i -g wrangler
wrangler login
wrangler secret put RELAY_TOKEN        # 可选但强烈建议
# 编辑 wrangler.toml 的 ALLOW_HOSTS（生产别用 "*"）
wrangler deploy                        # → wss://mremu-relay.<account>.workers.dev/
```

## 安全（必读）

这是公网 TCP 跳板，不做限制会被滥用（端口扫描/垃圾邮件）：

- `ALLOW_HOSTS`：目标主机白名单（支持 `*.example.com` 通配）
- `RELAY_TOKEN`：连接必须带 `?token=`，模拟器侧由 `TcpSock::connect` 拼进 URL
- 端口 25（SMTP）已硬禁；Cloudflare 本身也不允许连其自有 IP 段的某些目标
- 上线后开 `observability`，留意流量画像

## 与模拟器的对接（待部署后联调）

`MREmu/MREngine/Sock.cpp` 的 `TcpSock::connect` 在 `__EMSCRIPTEN__` 下需要：
1. 目标改写：真正要连的 `host:port` 编码成 `?token=..` 之外的控制帧（首条消息），
   WS 直接连 `wss://<relay>/?token=..`；
2. `read/write/close` 换成 `emscripten_websocket_send/deleter`，收到的 binary 消息进
   环形缓冲喂给 `read()`，`wait_for_read` 的就绪事件照旧走 `push_event`；
3. `UdpSock` 维持现状（返回错误）——边缘函数做不了出站 UDP。

C++ 侧代码骨架见 `MREmu-Web移植方案.md` §8.3 路线 B；这部分需要部署 Worker 后真机联调，
**尚未实测**。
