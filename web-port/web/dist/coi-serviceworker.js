/*
 * coi-serviceworker.js
 *
 * 用途：GitHub Pages / 静态对象存储这类"不能自定义响应头"的托管环境，
 * 通过 Service Worker 给所有同源响应补上 COOP/COEP，从而让
 * SharedArrayBuffer（pthreads 版 wasm 的前提）重新可用。
 *
 * 要求：HTTPS（或 localhost）。页面侧由 shell.html 在 crossOriginIsolated === false
 * 时自动注册，并用 sessionStorage 防止刷新循环。
 */

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // 跳过 cache-only 之类的特殊请求，避免 fetch 抛错
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  // 只处理同源请求；跨域资源交给标准的 CORP/CORS 规则
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // 导航请求强制绕过 HTTP 缓存：
  // 否则可能命中"没带 COOP/COEP 头"的旧缓存副本，导致刷新一次仍未隔离
  var isNav = (req.mode === 'navigate');

  event.respondWith(
    fetch(req, isNav ? { cache: 'reload' } : undefined).then(function (res) {
      // opaque response 不能改头
      if (res.status === 0) return res;

      var headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: headers
      });
    })
  );
});
