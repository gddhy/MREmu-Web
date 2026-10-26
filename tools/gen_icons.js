// gen_icons.js —— 用无头 Edge 把 ic_calculator-one.svg 栅格化成 PWA 用的 PNG
//   icons/icon-512.png  (512x512, 深色底 + 68% 内容 = maskable 安全区)
//   icons/icon-192.png  (192x192, 同风格)
// 用法: node gen_icons.js <svgPath> <outDir>

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SVG = process.argv[2] || 'web-port/web/ic_calculator-one.svg';
const OUT = process.argv[3] || 'web-port/web/icons';
const PORT = 9338;
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

function pageHtml(svg, size, iconSize) {
  return '<!doctype html><html><body style="margin:0;background:#101014">' +
    '<div style="width:' + size + 'px;height:' + size + 'px;display:grid;place-items:center">' +
    '<div style="width:' + iconSize + 'px;height:' + iconSize + 'px">' + svg + '</div></div></body></html>';
}

async function main() {
  const svg = fs.readFileSync(SVG, 'utf8')
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/width="48"/, 'width="100%"')
    .replace(/height="48"/, 'height="100%"');

  fs.mkdirSync(OUT, { recursive: true });

  const profile = path.join(os.tmpdir(), 'mremu-icons-' + Date.now());
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', 'about:blank',
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

  const jobs = [
    { size: 512, icon: 348, file: 'icon-512.png' },
    { size: 192, icon: 130, file: 'icon-192.png' },
  ];

  for (const j of jobs) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: j.size, height: j.size, deviceScaleFactor: 1, mobile: false,
    });
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(svg, j.size, j.icon));
    await send('Page.navigate', { url: dataUrl });
    await sleep(1200);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) {
      fs.writeFileSync(path.join(OUT, j.file), Buffer.from(shot.data, 'base64'));
      console.log('written', j.file);
    } else {
      console.log('FAILED', j.file);
    }
  }

  ws.close(); proc.kill(); await sleep(500); process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
