// cdp_vxp.js —— 打开页面 → 把本地 .vxp 注入 MEMFS → 调 mremu_push_vxp → 等 N 秒 → 截图/读日志
// 用法: node cdp_vxp.js <vxpPath> <waitMs> <outPng>

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const VXP = process.argv[2];
const WAIT = parseInt(process.argv[3] || '15000', 10);
const OUT_PNG = process.argv[4] || '';
const URL_ = 'http://localhost:8099/index.html';
const PORT = 9334;
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
  const vxpBytes = fs.readFileSync(VXP);
  const b64 = vxpBytes.toString('base64');
  const name = path.basename(VXP).replace(/[^\w.\-]+/g, '_');
  console.log(`vxp = ${VXP} (${vxpBytes.length} bytes) -> /mre/fs/e/${name}`);

  const profile = path.join(os.tmpdir(), 'mremu-vxp-' + Date.now());
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
    '--window-size=520,760', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find(t => t.type === 'page');
    } catch (e) {}
  }
  if (!target) { console.log('ERR: DevTools 连不上'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  const send = (method, params) => new Promise(res => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      logs.push('[' + m.params.type + '] ' + t);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[exception] ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    }
  };

  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });

  // 等 mremu_ready
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const r = await send('Runtime.evaluate', { expression: "(document.getElementById('stat')||{}).textContent||''", returnByValue: true });
    if (/就绪/.test((r.result && r.result.value) || '')) { ready = true; break; }
  }
  console.log('ready =', ready);

  const inject = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      try { Module.FS.mkdir('/mre/fs/e'); } catch (e) {}
      Module.FS.writeFile('/mre/fs/e/${name}', arr);
      try { Module.FS.syncfs(false, () => {}); } catch (e) {}
      const rc = Module.ccall('mremu_push_vxp', 'number', ['string'], ['/mre/fs/e/${name}']);
      return rc + ' / ' + arr.length;
    })()`,
  });
  console.log('inject =', inject && inject.result && (inject.result.value || inject.result.description));

  await sleep(WAIT);

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      stat: (document.getElementById('stat')||{}).textContent,
      log: (document.getElementById('log')||{}).innerText,
      canvasW: (document.getElementById('canvas')||{}).width,
      canvasH: (document.getElementById('canvas')||{}).height,
      fsE: (function(){try{return Module.FS.readdir('/mre/fs/e').join(',');}catch(e){return 'err:'+e.message;}})()
    })`,
  });

  if (OUT_PNG) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'));
  }

  console.log('=== PROBE ===');
  console.log(probe && probe.result && probe.result.value);
  console.log('=== CONSOLE (' + logs.length + ') ===');
  console.log(logs.filter(l => !/GL Driver Message|INVALID_ENUM/.test(l)).slice(-40).join('\n'));

  ws.close(); proc.kill(); await sleep(500); process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
