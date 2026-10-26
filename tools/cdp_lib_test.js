// cdp_lib_test.js —— 验证"已导入文件库 + 刷新恢复"：
//   1) 打开页面 → 注入 VXP 运行（等同手动导入）
//   2) 重新加载页面（模拟下次打开）
//   3) 不注入任何东西，通过 UI 下拉框选择 → 应直接运行
// 用法: node cdp_lib_test.js <vxpPath> <outPng>

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const VXP = process.argv[2];
const OUT_PNG = process.argv[3] || '';
const URL_ = 'http://localhost:8099/index.html';
const PORT = 9335;
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

  const profile = path.join(os.tmpdir(), 'mremu-lib-' + Date.now());
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

  async function waitReady(tag) {
    for (let i = 0; i < 100; i++) {
      await sleep(500);
      const r = await send('Runtime.evaluate', { expression: "(document.getElementById('stat')||{}).textContent||''", returnByValue: true });
      const v = (r.result && r.result.value) || '';
      if (/就绪/.test(v)) { console.log(`[${tag}] ready: ` + v); return v; }
    }
    console.log(`[${tag}] TIMEOUT waiting ready`);
    return '';
  }

  // ---- 第 1 步：导入并运行 ----
  await send('Page.navigate', { url: URL_ });
  await waitReady('step1');

  const inj = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      try { Module.FS.mkdir('/mre/fs/e'); } catch (e) {}
      Module.FS.writeFile('/mre/fs/e/${name}', arr);
      await new Promise(r => Module.FS.syncfs(false, r));
      const rc = Module.ccall('mremu_push_vxp', 'number', ['string'], ['/mre/fs/e/${name}']);
      return 'import+launch rc=' + rc;
    })()`,
  });
  console.log('[step1]', inj && inj.result && (inj.result.value || inj.result.description));
  await sleep(4000);

  // ---- 第 2 步：刷新页面（模拟"下次打开"）----
  await send('Page.navigate', { url: URL_ });
  const stat2 = await waitReady('step2');

  // ---- 第 3 步：纯 UI 操作：读下拉框 → 选第一项 → 应直接运行 ----
  const ui = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const sel = document.getElementById('lib');
      const opts = [...sel.options].map(o => o.value).filter(v => v);
      if (!opts.length) return 'LIB EMPTY';
      sel.value = opts[0];
      sel.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 3000));
      return JSON.stringify({ lib: opts, stat: document.getElementById('stat').textContent });
    })()`,
  });
  console.log('[step3 UI]', ui && ui.result && (ui.result.value || ui.result.description));
  await sleep(3000);

  if (OUT_PNG) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'));
  }

  console.log('=== exceptions ===');
  console.log(logs.slice(-6).join('\n') || '(none)');
  ws.close(); proc.kill(); await sleep(500); process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
