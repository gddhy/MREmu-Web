// cdp_fix_test.js —— 验证两个修复：
//   1) 中文名文件导入不再被吞（走真实 loadVxp(new File(...)) 路径）
//   2) "删除"按钮真正生效（下拉框选中 → 点击删除 → 文件从 FS/IndexedDB 消失，刷新后仍为空）
// 用法: node cdp_fix_test.js <vxpPath>

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const VXP = process.argv[2];
const URL_ = 'http://localhost:8099/index.html';
const PORT = 9336;
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

  const profile = path.join(os.tmpdir(), 'mremu-fix-' + Date.now());
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
    for (let i = 0; i < 100; i++) {
      await sleep(500);
      const r = await send('Runtime.evaluate', { expression: "(document.getElementById('stat')||{}).textContent||''", returnByValue: true });
      const v = (r.result && r.result.value) || '';
      if (/就绪/.test(v)) { console.log(`[${tag}] ` + v); return; }
    }
    console.log(`[${tag}] TIMEOUT`);
  }

  await send('Page.navigate', { url: URL_ });
  await waitReady('step1');

  // ---- 1) 走真实 loadVxp 路径导入中文名文件 ----
  const imp = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], ${JSON.stringify(CN_NAME)});
      loadVxp(file);                       // 真实 UI 代码路径
      await new Promise(r => setTimeout(r, 2500));
      return JSON.stringify({
        libNames: Lib.list().map(x => x.name),
        fsE: Module.FS.readdir('/mre/fs/e').filter(n => n !== '.' && n !== '..'),
        stat: document.getElementById('stat').textContent,
      });
    })()`,
  });
  console.log('[step1 中文导入]', imp && imp.result && (imp.result.value || imp.result.description));

  // ---- 1b) 中文名文件能否被模拟器本身加载运行 ----
  const run = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      Lib.launch(${JSON.stringify(CN_NAME)});
      await new Promise(r => setTimeout(r, 4000));
      return JSON.stringify({
        stat: document.getElementById('stat').textContent,
        appLog: (document.getElementById('log')||{}).innerText.includes('[Game2048]'),
      });
    })()`,
  });
  console.log('[step1b 中文启动]', run && run.result && (run.result.value || run.result.description));

  if (process.argv[3]) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) fs.writeFileSync(process.argv[3], Buffer.from(shot.data, 'base64'));
  }

  // ---- 2) 选中 → 点删除按钮 ----
  const del = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      window.confirm = () => true;         // 无头环境自动确认
      const sel = document.getElementById('lib');
      sel.value = ${JSON.stringify(CN_NAME)};
      document.getElementById('btn-del').click();
      await new Promise(r => setTimeout(r, 1500));
      return JSON.stringify({
        libNames: Lib.list().map(x => x.name),
        fsE: Module.FS.readdir('/mre/fs/e').filter(n => n !== '.' && n !== '..'),
        libHidden: document.getElementById('lib').className.includes('hideable'),
      });
    })()`,
  });
  console.log('[step2 删除]', del && del.result && (del.result.value || del.result.description));

  // ---- 3) 刷新页面，确认 IndexedDB 里也删干净了 ----
  await send('Page.navigate', { url: URL_ });
  await waitReady('step3');
  const after = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      libNames: Lib.list().map(x => x.name),
      stat: document.getElementById('stat').textContent,
    })`,
  });
  console.log('[step3 刷新后]', after && after.result && (after.result.value || after.result.description));

  ws.close(); proc.kill(); await sleep(500); process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
