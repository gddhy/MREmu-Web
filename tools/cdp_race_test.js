// cdp_race_test.js —— 复现并验证"多窗口下文件库丢失"的修复
//   场景：窗口 A 导入 测试一.vxp；另一窗口 B 导入 测试二.vxp（用 idbPut 模拟，
//   与真实跨窗口等价——同一个 origin 的 IndexedDB）；然后窗口 A 再触发一次
//   IDBFS 全量同步（旧版会在这里把 B 的文件从远程"修剪"掉）。
//   修复后：文件库以自建 IndexedDB 为准 → 两个文件都在；且 Lib.launch 会把
//   被竞态弄丢的副本重新物化后正常运行。
// 用法: node cdp_race_test.js <vxpPath>

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const VXP = process.argv[2];
const URL_ = 'http://localhost:8100/index.html';
const PORT = 9341;
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

  const profile = path.join(os.tmpdir(), 'mremu-race-' + Date.now());
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

  // 窗口 A：真实 loadVxp 导入 测试一
  const s1 = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      loadVxp(new File([new Uint8Array(bin.length).map((_, i) => bin.charCodeAt(i))], '测试一.vxp'));
      await new Promise(r => setTimeout(r, 2000));
      return (await Lib.list()).map(x => x.name).join(',');
    })()`,
  });
  console.log('[A 导入后]', s1 && s1.result && s1.result.value);

  // 窗口 B（另一个窗口）：直接往共享的自建库 put 测试二（与跨窗口等价）
  const s2 = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const buf = new Uint8Array(bin.length).map((_, i) => bin.charCodeAt(i)).buffer;
      await Lib.idbPut('测试二.vxp', buf);
      return 'B 已导入 测试二.vxp';
    })()`,
  });
  console.log('[B 导入]', s2 && s2.result && s2.result.value);

  // 窗口 A 触发一次 IDBFS 全量同步（旧版在这里会把 B 的文件从远程修剪掉）
  const s3 = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      await new Promise(r => Module.FS.syncfs(false, r));
      const lib = (await Lib.list()).map(x => x.name);
      return JSON.stringify({ lib, fsE: Module.FS.readdir('/mre/fs/e').filter(n => n !== '.' && n !== '..') });
    })()`,
  });
  console.log('[A 同步后]', s3 && s3.result && (s3.result.value || s3.result.description));

  // 从库启动 测试二（应自愈物化后正常运行）
  const s4 = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      await Lib.launch('测试二.vxp');
      await new Promise(r => setTimeout(r, 4000));
      return JSON.stringify({
        stat: document.getElementById('stat').textContent,
        gameLog: (document.getElementById('log')||{}).innerText.includes('[Game2048]'),
        fsE: Module.FS.readdir('/mre/fs/e').filter(n => n !== '.' && n !== '..'),
      });
    })()`,
  });
  console.log('[启动测试二]', s4 && s4.result && (s4.result.value || s4.result.description));

  // 刷新页面：确认两个文件都还在（自建库持久化）
  await send('Page.navigate', { url: URL_ });
  await waitReady('reload');
  const s5 = await send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      await new Promise(r => setTimeout(r, 1000));
      return JSON.stringify({ lib: (await Lib.list()).map(x => x.name) });
    })()`,
  });
  console.log('[刷新后]', s5 && s5.result && (s5.result.value || s5.result.description));

  ws.close(); proc.kill(); await sleep(500); process.exit(0);
}

main().catch(e => { console.log('FATAL', e && e.message); process.exit(1); });
