# MREmu Project —— MRE (VXP) 模拟器 · Web(Wasm) 

本目录是 [XimikBoda/MREmu](https://github.com/XimikBoda/MREmu)（上游 master `8c7af51`）
与 **Web/Wasm 移植改动**合并后的完整项目，可直接构建浏览器版。

## 目录结构

```
MREmu-project/
├── CMakeLists.txt             ← 根构建脚本（含 Emscripten 分支，已修好链接参数）
├── MREmu/                     ← 模拟器主体（含 WebBridge.cpp：JS↔C++ 桥）
├── MREmu/MREngine/            ← MRE SDK 宿主实现（联网 §8.3 见方案文档）
├── web/                       ← Web 壳与资源（构建时直接使用）
│   ├── shell.html             ← 自定义 emscripten shell（PWA + 自绘控件 + 文件库）
│   ├── manifest.json          ← PWA 清单（file_handlers: .vxp / navigate-new）
│   ├── ic_calculator-one.svg  ← 应用图标（字节 IconPark，浅色描边副本）
│   ├── icons/icon-512|192.png ← 栅格化图标（maskable）
│   ├── char_traits_shim.h     ← libc++ 兼容头（SFML 2.6 必需）
│   ├── coi-serviceworker.js   ← 静态托管补 COOP/COEP（无头服务器也能跑）
│   └── serve.py               ← 本地调试服务器
├── MREmu/WebBridge.cpp        ← 暴露 mremu_ready / mremu_push_vxp 给 JS
├── bin/                       ← 最近一次构建产物（MREmu.html/.js/.wasm，可直接部署）
├── web-port/                  ← Web 移植的脚本与文档（详见其中 README/方案文档）
│   ├── MREmu-Web移植方案.md   ← 完整方案：架构/实测/踩坑/路线
│   ├── build_web.sh           ← 一键构建（打补丁→configure→编译→web/dist）
│   ├── apply_web_patch.py     ← 对上游原始仓库打补丁（幂等，含 overlay）
│   ├── patches/               ← 补丁本体（git patch + 新增文件）
│   ├── edge-relay/            ← 联网边缘转发（Cloudflare Worker，仅方案与代码，未部署）
│   └── web/dist/              ← 可直接部署的静态站点（含 PWA 资源）
└── tools/                     ← 辅助脚本（CDP 验证、图标生成）
```

## 构建 Web 版（Emscripten）

前置：emsdk（Emscripten 6.x 实测通过）+ CMake 3.29+ Ninja（可 pip 装）+
MRE SDK 头文件（`MRE_SDK` 环境变量，指向含 `include/vmsys.h` 的目录）。

```bash
export MRE_SDK="/path/to/MRE_SDK"    # 目录下要有 include/vmsys.h
bash web-port/build_web.sh Release      # 产物在 web-port/web/dist/
cd web-port/web/dist && python serve.py 8099   # 本地预览（带 COOP/COEP 头）
```

直接部署：把 `web-port/web/dist/` 传到任意支持 HTTPS + Service Worker 的静态托管
（无需配置响应头，页面会自动通过 Service Worker 补上；首次访问自动刷新一次）。

### 部署到 EdgeOne Pages（腾讯云，国内访问友好）

1. **改远端后再提交**（当前 `origin` 指向上游 `github.com/XimikBoda/MREmu`，别误推）：
   ```bash
   git remote set-url origin <你的仓库地址>     # 或 git remote add mine <地址>
   git add -A && git commit -m "MREmu web/wasm port"
   git push origin HEAD
   ```
   注意：`bin/` 被上游 `.gitignore` 忽略（构建输出），**`web-port/web/dist/` 不被忽略**，
   静态产物会随提交一起进仓库——这正是 EdgeOne 部署要用的目录。
2. EdgeOne Pages 新建站点 → 绑定该仓库 → 构建输出目录填 `web-port/web/dist`（或把该目录内容
   作为发布根目录）→ 部署。
3. 域名默认带 HTTPS（Service Worker 需要）；404 页面用 `web-port/web/dist/404.html`
   （不存在路径会自动跳回 `/`）。
4. 若 EdgeOne 支持自定义响应头，可另加 `Cross-Origin-Opener-Policy: same-origin` 与
   `Cross-Origin-Embedder-Policy: require-corp`，那样就不会触发 Service Worker 的补头逻辑。

## dist 目录内容（可直接部署）

```
web-port/web/dist/
├── index.html            ← 主页面（由 emscripten 用 web/shell.html 生成）
├── MREmu.js / MREmu.wasm
├── manifest.json         ← PWA（file_handlers 仅 .vxp；launch_handler: navigate-new）
├── ic_calculator-one.svg ← 图标（字节 IconPark）
├── icons/icon-512|192.png
├── coi-serviceworker.js  ← 无 COOP/COEP 响应头时的补头兜底
├── 404.html              ← 访问不存在路径时跳回 /
└── serve.py              ← 本地调试服务器（带 COOP/COEP 头）
```

## 已完成 / 实测状态

- ✅ Wasm 编译（`MREmu.wasm` 6.9MB）+ 浏览器运行（Game2048 完整可玩）
- ✅ PWA 安装（manifest + file_handlers: 双击 .vxp 新窗口打开自动运行）
- ✅ 已导入文件库（自建 IndexedDB，多窗口竞态自愈，中文名支持）
- ✅ 静态托管无响应头部署（Service Worker 补 COOP/COEP）
- ✅ 加载页项目来源标注（github.com/XimikBoda/MREmu）
- ⚠️ 联网（vm_tcp_*）：仅完成方案与边缘转发代码（`web-port/edge-relay/`），
  **未部署验证**；UDP 无解（边缘函数无出站 UDP）
- ⚠️ 部分 VXP（如 HelloWorld.vxp）在 Unicorn TCI 下抛 `UC_ERR_EXCEPTION`，待排查

## Web 移植改动的文件清单

对上游的修改见 `web-port/patches/0001-mremu-web-port.patch`（已应用），新增文件：
`MREmu/WebBridge.cpp`、`web/*`。回滚/重放：`python web-port/apply_web_patch.py --revert`。

完整方案（架构图、逐文件改动、踩坑记录、性能与联网路线）：
**`web-port/MREmu-Web移植方案.md`**
