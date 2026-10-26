// cdp_pwa_test.js —— 验证 PWA + 自绘控件（在"无 COOP/COEP 头的静态托管"上测试，一并回归 SW 流程）
//   1) SW 补头 → 隔离 → 就绪
//   2) 加载页下方有项目来源链接
//   3) manifest.json 可取、file_handlers/launch_handler 配置正确、launchQueue 已接
//   4) 自绘下拉面板：中文名文件显示完整 → 点行运行
//   5) 自绘确认弹窗：点 ✕ → 弹窗 → 确定 → 删除生效
// 用法: node cdp_pwa_test.js <vxpPath> <shotMenuPng>

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const VXP = process.argv[2];
const OUT_PNG = process.argv[3] || '';
const URL_ = 'http://localhost:8100/index.html';
const PORT = 9339;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CN_NAME = '2048测试游戏.vxp';

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

  const profile = path.join(os.tmpdir(), 'mremu-pwa-' + Date.now());
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
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');

  async function waitReady(tag) {
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      try {
        const r = await send('Runtime.evaluate', { expression: "(document.getElementById('stat')||{}).textContent||''", returnByValue: true });
        const v = (r.result && r.result.value) || '';
        if (/就绪/.test(v)) { console.log(`[${tag}] ` + v); return v; }
      } catch (e) { /* reload 中 */ }
    }
    console.log(`[${tag}] TIMEOUT`);
    return '';
  }

  await send('Page.navigate', { url: URL_ });
  await waitReady('boot');

  const env = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      isolated: self.crossOriginIsolated,
      srcAttr: (document.querySelector('#splash .src a')||{}).href,
      srcText: (document.querySelector('#splash .src')||{}).textContent,
      manifestLink: (document.querySelector('link[rel=manifest]')||{}).href,
      launchQueue: ('launchQueue' in window),
    })`,
  });
  console.log('[env]', env && env.result && env.result.value);

  const mf = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const r = await fetch('manifest.json');
      const j = await r.json();
      const icon = await fetch('ic_calculator-one.svg');
      const png = await fetch('icons/icon-512.png');
      return JSON.stringify({
        status: r.status,
        name: j.name,
        client_mode: j.launch_handler && j.launch_handler.client_mode,
        file_handlers: (j.file_handlers || []).map(h => Object.keys(h.accept).length + ':' + h.action),
        iconSvg: icon.status, iconPng: png.status,
      });
    })()`,
  });
  console.log('[manifest]', mf && mf.result && (mf.result.value || mf.result.description));

  // 导入中文名文件（真实 loadVxp 路径）
  const imp = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      loadVxp(new File([arr], ${JSON.stringify(CN_NAME)}));
      await new Promise(r => setTimeout(r, 2000));
      document.getElementById('lib-btn').click();          // 打开自绘下拉
      await new Promise(r => setTimeout(r, 300));
      const rows = [...document.querySelectorAll('#lib-menu .lib-row .nm')].map(x => x.textContent);
      return JSON.stringify({ count: document.getElementById('lib-count').textContent, rows, menuOpen: !document.getElementById('lib-menu').className.includes('hideable') });
    })()`,
  });
  console.log('[import+menu]', imp && imp.result && (imp.result.value || imp.result.description));

  if (OUT_PNG) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'));
  }

  // 点行运行
  const run = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      document.querySelector('#lib-menu .lib-row').click();
      await new Promise(r => setTimeout(r, 3500));
      return JSON.stringify({ stat: document.getElementById('stat').textContent,
                              menuClosed: document.getElementById('lib-menu').className.includes('hideable') });
    })()`,
  });
  console.log('[row-run]', run && run.result && (run.result.value || run.result.description));

  // 自绘确认弹窗删除
  const del = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      document.getElementById('lib-btn').click();
      await new Promise(r => setTimeout(r, 300));
      document.querySelector('#lib-menu .lib-row .del').click();
      await new Promise(r => setTimeout(r, 300));
      const modalShown = !document.getElementById('modal').className.includes('hideable');
      const modalMsg = document.getElementById('modal-msg').textContent;
      document.getElementById('modal-ok').click();
      await new Promise(r => setTimeout(r, 1200));
      return JSON.stringify({
        modalShown, modalMsg,
        count: document.getElementById('lib-count').textContent,
        fsE: Module.FS.readdir('/mre/fs/e').filter(n => n !== '.' && n !== '..'),
      });
    })()`,
  });
  console.log('[modal-del]', del && del.result && (del.result.value || del.result.description));

  ws.close(); proc.kill(); await sleep(500); process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
