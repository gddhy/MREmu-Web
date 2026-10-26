// cdp_probe.js —— 零依赖：用 Node 内置 WebSocket 驱动 Edge/Chrome 的 DevTools 协议，
// 打开页面、抓 console/异常、等 N 秒后读页面状态并截图。
//
// 用法: node cdp_probe.js <url> <waitMs> [outPng]

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const URL_ = process.argv[2] || 'http://localhost:8099/index.html';
const WAIT = parseInt(process.argv[3] || '25000', 10);
const OUT_PNG = process.argv[4] || '';
const PORT = 9333;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  const profile = path.join(os.tmpdir(), 'mremu-cdp-' + Date.now());
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
    '--enable-features=SharedArrayBuffer',
    '--window-size=900,700',
    'about:blank',
  ];
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find(t => t.type === 'page');
    } catch (e) { /* not up yet */ }
  }
  if (!target) { console.log('ERR: 无法连接 DevTools'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];

  function send(method, params) {
    return new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const txt = (msg.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      logs.push('[console.' + msg.params.type + '] ' + txt);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const st = d.stackTrace && d.stackTrace.callFrames ? d.stackTrace.callFrames.slice(0,4).map(f=>f.functionName+':'+f.lineNumber).join(' <- ') : '';
      logs.push('[exception] ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text) + (st?'  @'+st:''));
    } else if (msg.method === 'Log.entryAdded') {
      logs.push('[log.' + msg.params.entry.level + '] ' + msg.params.entry.text);
    }
  };

  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });

  for (let i = 0; i < Math.ceil(WAIT / 1000); i++) {
    await sleep(1000);
    const st = await send('Runtime.evaluate', {
      expression: "(document.getElementById('stat')||{}).textContent || ''",
      returnByValue: true,
    });
    const v = st && st.result && st.result.value || '';
    if (/运行中|崩溃|失败/.test(v)) { if (i > 2) break; }
  }

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      isolated: self.crossOriginIsolated,
      sab: typeof SharedArrayBuffer !== 'undefined',
      stat: (document.getElementById('stat')||{}).textContent,
      splash: (document.getElementById('splash-msg')||{}).textContent,
      splashHidden: (document.getElementById('splash')||{className:''}).className.includes('hide'),
      canvasW: (document.getElementById('canvas')||{}).width,
      canvasH: (document.getElementById('canvas')||{}).height,
      webgl1: (function(){try{return !!document.createElement('canvas').getContext('webgl');}catch(e){return 'err:'+e.message;}})(),
      webgl2: (function(){try{return !!document.createElement('canvas').getContext('webgl2');}catch(e){return 'err:'+e.message;}})(),
      log: (document.getElementById('log')||{}).innerText
    })`,
  });

  if (OUT_PNG) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'));
  }

  console.log('=== PROBE ===');
  console.log(probe && probe.result && probe.result.value);
  console.log('=== CONSOLE (' + logs.length + ') ===');
  console.log(logs.slice(0, 80).join('\n'));

  ws.close();
  proc.kill();
  await sleep(500);
  process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
