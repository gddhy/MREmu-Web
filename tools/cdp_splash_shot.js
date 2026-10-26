// cdp_splash_shot.js —— 截取加载页（含"项目来源"标注）的早期画面
// 用法: node cdp_splash_shot.js <url> <outPng> [delayMs]

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const URL_ = process.argv[2] || 'http://localhost:8099/index.html';
const OUT_PNG = process.argv[3] || 'splash.png';
const DELAY = parseInt(process.argv[4] || '1500', 10);
const PORT = 9340;
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
  const profile = path.join(os.tmpdir(), 'mremu-splash-' + Date.now());
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
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
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  await send('Page.enable');

  await send('Page.navigate', { url: URL_ });
  await sleep(DELAY);

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      splashVisible: !document.getElementById('splash').className.includes('hide'),
      msg: document.getElementById('splash-msg').textContent,
      src: (document.querySelector('#splash .src')||{}).textContent,
    })`,
  });
  console.log('[splash]', probe && probe.result && probe.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'));

  ws.close(); proc.kill(); await sleep(500); process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
