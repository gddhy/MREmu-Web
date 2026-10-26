// cdp_static_test.js —— 模拟"无 COOP/COEP 响应头的静态托管"：
// 用不带任何跨源头的 python http.server 起服务，验证页面能通过
// Service Worker 自动补头 → 刷新 → crossOriginIsolated=true → 正常运行 VXP。
// 用法: node cdp_static_test.js <vxpPath> <outPng>

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const VXP = process.argv[2];
const OUT_PNG = process.argv[3] || '';
const URL_ = 'http://localhost:8100/index.html';
const PORT = 9337;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const b64 = fs.readFileSync(VXP).toString('base64');

  const profile = path.join(os.tmpdir(), 'mremu-static-' + Date.now());
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
    '--window-size=760,860', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find(t => t.type === 'page');
    } catch (e) {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[exception] ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    }
  };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');

  // 首次导航（此时页面还不是 crossOriginIsolated，shell 会注册 SW 并自动刷新一次）
  await send('Page.navigate', { url: URL_ });

  // 轮询：等刷新完成 + 模拟器就绪（容忍中间多次 reload / context 销毁）
  let readyStat = '';
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const r = await send('Runtime.evaluate', { expression: "(document.getElementById('stat')||{}).textContent||''", returnByValue: true });
      const v = (r.result && r.result.value) || '';
      if (/就绪|已导入/.test(v)) { readyStat = v; break; }
    } catch (e) { /* navigation 中，忽略 */ }
  }
  console.log('[ready]', readyStat || 'TIMEOUT');

  const probe1 = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({ isolated: self.crossOriginIsolated, sw: !!navigator.serviceWorker.controller })`,
  });
  console.log('[env]', probe1 && probe1.result && probe1.result.value);

  // 注入 VXP 并从"文件库"启动（完整 UI 等价路径）
  const run = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      try { Module.FS.mkdir('/mre/fs/e'); } catch (e) {}
      Module.FS.writeFile('/mre/fs/e/game2048.vxp', arr);
      await new Promise(r => Module.FS.syncfs(false, r));
      Lib.refresh();
      Lib.launch('game2048.vxp');
      await new Promise(r => setTimeout(r, 4000));
      return JSON.stringify({ stat: document.getElementById('stat').textContent });
    })()`,
  });
  console.log('[run]', run && run.result && (run.result.value || run.result.description));

  if (OUT_PNG) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'));
  }

  console.log('=== exceptions ===');
  console.log(logs.slice(-5).join('\n') || '(none)');
  ws.close(); proc.kill(); await sleep(500); process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
