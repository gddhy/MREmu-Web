/**
 * worker.js —— MREmu 边缘转发（Cloudflare Workers）
 *
 * 架构：
 *   MRE 应用(vm_tcp_*) → 浏览器 WebSocket(wss://本worker/?token=..)
 *     → 本 Worker 校验白名单/令牌 → connect()(cloudflare:sockets) 出站 TCP
 *     → 双向透传
 *
 * 协议（自定义，非 websockify）：
 *   浏览器 → Worker，第一条二进制消息（控制帧 CONNECT）：
 *       [0x01][port 高8][port 低8][host bytes...]
 *   Worker → 浏览器：
 *       [0x02] = TCP 已建立（之后为纯数据透传）
 *       WS close(1008/1011) = 失败/断开
 *   建立后：双向 binary message = TCP 字节流（一条 WS 消息 ≈ 一次 write/read）
 *
 * 部署：
 *   1) npm i -g wrangler; wrangler login
 *   2) wrangler secret put RELAY_TOKEN     （可选但强烈建议）
 *   3) 编辑 wrangler.toml 里的 ALLOW_HOSTS 白名单
 *   4) wrangler deploy   → 得到 wss://mremu-relay.<account>.workers.dev/
 *
 * 安全提示：这是个 TCP 跳板，务必配置 ALLOW_HOSTS 和 RELAY_TOKEN，
 * 否则会被滥用做端口扫描/垃圾邮件跳板（端口 25 已硬禁）。
 */

import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 非 WebSocket 请求：给个状态页（顺便当健康检查）
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('MREmu edge relay is running.\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // 令牌校验（配了 RELAY_TOKEN 就必须带上 ?token=）
    if (env.RELAY_TOKEN && url.searchParams.get('token') !== env.RELAY_TOKEN) {
      return new Response('forbidden\n', { status: 403 });
    }

    const pair = new WebSocketPair();
    pair[1].accept();
    handleRelay(pair[1], env);

    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};

function hostAllowed(host, allowList) {
  if (!allowList || allowList.length === 0 || allowList[0] === '*') return true;
  const h = String(host).toLowerCase();
  return allowList.some(function (pattern) {
    var p = pattern.toLowerCase();
    if (p === '*') return true;
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) || h === p.slice(2);
    return h === p;
  });
}

function handleRelay(ws, env) {
  var tcp = null;         // cloudflare:sockets 的 TCP socket
  var writer = null;      // tcp.writable 的 writer
  var allowList = (env.ALLOW_HOSTS || '*').split(',').map(function (s) { return s.trim(); });

  function safeClose(code, reason) {
    try { ws.close(code, reason); } catch (e) { /* 已关 */ }
  }
  function teardown() {
    try { if (writer) writer.releaseLock(); } catch (e) {}
    writer = null;
    try { if (tcp) tcp.close(); } catch (e) {}
    tcp = null;
  }

  ws.addEventListener('message', function (ev) {
    if (typeof ev.data === 'string') return;           // 只收二进制
    var buf;
    try { buf = new Uint8Array(ev.data); } catch (e) { return; }

    // ---- 控制帧：建立 TCP ----
    if (!tcp) {
      if (buf.length < 4 || buf[0] !== 0x01) { safeClose(1008, 'bad handshake'); return; }
      var port = (buf[1] << 8) | buf[2];
      var host = new TextDecoder().decode(buf.slice(3)).trim();

      if (!host || !hostAllowed(host, allowList)) { safeClose(1008, 'host not allowed'); return; }
      if (port <= 0 || port === 25 || port > 65535) { safeClose(1008, 'port blocked'); return; }

      try {
        tcp = connect({ hostname: host, port: port });
      } catch (e) {
        safeClose(1011, 'connect failed'); return;
      }

      writer = tcp.writable.getWriter();
      var opened = false;

      // TCP → 浏览器
      tcp.readable.pipeTo(new WritableStream({
        write: function (chunk) {
          if (ws.readyState === 1) ws.send(chunk);
        },
        close: function () { safeClose(1000, 'tcp closed'); },
        abort: function () { safeClose(1006, 'tcp aborted'); },
      })).catch(function () { safeClose(1006, 'tcp error'); });

      // TCP 建立成功后回 ACK（cloudflare:sockets 的 connect 是立刻返回句柄、
      // 由 open 事件表示握手完成；这里用 readable 上有数据/无错误来近似，
      // 简化起见直接回 ACK，MRE 侧本来就有 CONNECTED/PIPE_BROKEN 事件模型）
      ws.send(new Uint8Array([0x02]));
      opened = true;
      return;
    }

    // ---- 数据帧：浏览器 → TCP ----
    if (writer) {
      writer.write(buf).catch(function () { safeClose(1006, 'write failed'); });
    }
  });

  ws.addEventListener('close', teardown);
  ws.addEventListener('error', teardown);
}
