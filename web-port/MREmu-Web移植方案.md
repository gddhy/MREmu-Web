# MREmu → Web (WebAssembly) 移植方案

> 分析对象：`https://github.com/XimikBoda/MREmu` @ `master` (`8c7af51`)
> 本地路径：`../repo`（已 clone，已打上本文配套的最小补丁）
> 结论日期：2026-10-26

---

## 0. 一句话结论

**可行，而且不是从零开始。** 仓库里已经躺着一条半成品的 Web 通道：根 `CMakeLists.txt` 有完整的
`if(EMSCRIPTEN)` 链接参数块，`deps/CMakeLists.txt` 在 wasm 下会自动换成 *SFML 的 Emscripten 移植版*
和 *作者自己改的 Unicorn*（把 QEMU TCG 换成了 **TCI 解释器**，因为浏览器里不能 JIT）。
缺的是"最后一公里"：入口导出、文件注入、主循环让出、网络/录音隔离。

| 维度 | 判定 | 说明 |
|---|---|---|
| 能否编出 wasm | 🟢 大概率 | 上游依赖已经为 emscripten 铺好，只需修链接参数与 4 处平台判断 |
| 能否在浏览器跑起来 | 🟡 中等把握 | 卡在"主循环如何让出 CPU"和 SFML-EMCC 移植版的完整度 |
| 速度 | 🟠 主要风险 | Unicorn **TCI 解释** ≈ 比 JIT 慢一个数量级，2D 小游戏可接受，3D/重逻辑会掉帧 |
| 联网类应用 | 🔴 需要额外工程 | 浏览器不能直连 TCP/UDP，得走 WebSocket 中继 |
| 存档/截图 | 🟢 好办 | Emscripten 有 MEMFS/IDBFS，改 3 行代码即可持久化 |

---

## 0.5 实测结果（2026-10-26，本机已验证 ✅）

环境：Windows 11 + Git Bash，Emscripten **6.0.13**（emsdk latest），CMake 3.29.6 + Ninja（pip 装），
MRE SDK **3.0.00.03 中文版**（`Desktop\docker\MRE SDK V3.0.00`）。

| 项 | 结果 |
|---|---|
| 编译 | ✅ 全部通过，产物 `MREmu.js`(290KB) + `MREmu.wasm`(**6.9MB**) + `MREmu.html` |
| 浏览器启动 | ✅ 无头 Edge 验证：`crossOriginIsolated=true`，软键盘 + 240×528 画布正常渲染 |
| Unicorn(TCI) in wasm | ✅ ARM 模块正常执行（`vm_get_sym_entry(armodule_malloc) -> 0x00a201db`） |
| 运行 Game2048.vxp | ✅ **完整跑通**：中文 UI、菜单、图形层、软件键盘全部正常（见截图） |
| 文件持久化 | ✅ IDBFS 挂载成功，`[idbfs] 已恢复本地文件` |
| 已导入文件库 | ✅ 手动导入过的 VXP 存 IndexedDB（`/mre/fs/e/`），刷新页面后顶部下拉框点选即运行，可删除（CDP 三步验证：导入→刷新→纯 UI 选择运行） |
| 工具栏布局 | ✅ 改为上下固定条（非悬浮），画布独占中间区域，任何窗口尺寸都不会遮挡屏幕 |
| HelloWorld.vxp | ⚠️ `uc_emu_start returned 21 (UC_ERR_EXCEPTION)` @ PC=0x340F4，需进一步排查（见 §8.5） |

从干净克隆到能玩的全过程已脚本化：`apply_web_patch.py`（对上游 master `8c7af51` 可重复应用，
已在干净克隆上验证 diff 与本机完全一致）→ `build_web.sh` → `serve.py`。

**踩过的坑（都已修掉，换环境重编时注意）：**
1. **SFML 2.6 的 `sf::String` 用 `std::basic_string<Uint32>`**，libc++ 没有对应 `char_traits` 特化 →
   补 `web/char_traits_shim.h`，用 `-include` 强制注入。**该头文件必须保持 C++98 兼容**
   （libADLMIDI 按 `-std=gnu++98` 编译，用 C++11 语法会把它带崩）。
2. **MRE SDK 3.0.00.03 只有 `vm_set_volume`**，没有 `vm_get_volume` 声明 → 补进 `deps/mresdk/vmmissing.h`，
   且 `Audio.cpp` 要 `#include <vmmissing.h>` 让定义继承 C 链接。
3. **`App.cpp` 的 `lseek/read/close`** 只在 WIN32 分支包含了 `<io.h>` → 非 Windows 需要 `<unistd.h>`。
4. **不要设 `-sEXPORT_NAME`**：生成代码会去找"同名全局变量"当 Module 配置，自定义 shell 里的
   `var Module = {...}` 会被无视（canvas/print 回调全部失效）。
5. **shell 里的注释不能包含 `{{{ SCRIPT }}}` 占位符**：emscripten 会替换成真的 `<script>` 标签，
   把内联脚本从中间截断（页面表现是"整个配置失效"）。
6. **Emscripten 6 已移除 `FS.filesystems`** → IDBFS 用 `-lidbfs.js` 链接、`Module.IDBFS` 取用。
7. **`-sMINIFY_HTML`**（Release 默认开）会调 `html-minifier-terser`，emsdk 没装 node_modules 会失败 → 关掉。
8. **改 `--shell-file` 后 ninja 不会重链**（shell 不是依赖），要先删 `bin/MREmu.html|js`。
9. emcmake 传 `-DFETCHCONTENT_SOURCE_DIR_*` 必须用 Windows 绝对路径（`cygpath -w`），`/c/...` 会判"目录不存在"。
10. 文件名清洗不能用 `[^\w.\-]`：JS 的 `\w` 只匹配 ASCII，中文名会被吞成下划线；改用"只替换路径非法字符"的
    白名单式清洗（`Lib.safeName`）。
11. 下拉框启动后如果重置回占位符，"删除"按钮就拿不到目标 → 选中项保持不动，另用 `Lib.current`
    记录最近运行的文件作为删除兜底。

---

## 1. 这个项目是什么

MediaTek **MRE**（MAUI Runtime Environment，功能机时代的 `.vxp` 应用/游戏平台）与 **VRE** 的模拟器。
它不做"整机模拟"，而是**只模拟应用层**：用 Unicorn 跑 ARMv5 Thumb 的用户代码，把 MRE SDK 的
200+ 个 `vm_*` API 用宿主 C++ 重新实现，再自己实现了一套图形/资源/定时器/输入/音频子系统。

代码规模（`MREmu/` 目录）：

```
MREmu/*.cpp *.h           ~10.2k 行   核心：内存、CPU、桥接、App 装载、设备 UI
MREmu/MREngine/*.cpp      ~5.4k 行   MRE SDK 的宿主实现（图形/资源/IO/定时器/音频/网络）
MREmu/Device/*            ~1.5k 行   屏幕缩放 + 软键盘 + 菜单栏
MREmu/NativeApps/          少量      内置原生 App（应用选择器）
deps/                                SFML 2.6.2 / Unicorn / ADLMIDI / imgui / miniz / libiconv / asio / spdlog
sub/ARModule, sub/FontHexToBin       ARM 侧小工具、字体转换工具（与 Web 无关）
```

关键文件与职责：

| 文件 | 职责 | Web 相关度 |
|---|---|---|
| `MREmu/MREmu.cpp` | `main()`：建窗口、建 AppManager、60fps 主循环 | 🔴 高（要改主循环） |
| `MREmu/Memory.cpp` | 32MB "共享内存"池；**guest 地址 == 宿主指针** | 🟠 中（对齐/指针宽度） |
| `MREmu/Cpu.cpp` | Unicorn 引擎管理、`push_cpu/pop_cpu`、hooks | 🟠 中（TCI 性能） |
| `MREmu/Bridge.cpp` | guest↔host 调用桥（ARM 蹦床 + `UC_HOOK_CODE`） | 🟢 低（纯逻辑） |
| `MREmu/AppManager.cpp` | 事件队列 + 模拟线程主循环（`cv.wait_for`） | 🟠 中（线程模型） |
| `MREmu/Graphic.cpp` | RGB565 → RGBA → `sf::Texture` | 🟢 低 |
| `MREmu/Network.cpp` + `MREngine/Sock.cpp` | asio TCP/UDP | 🔴 高（浏览器无 raw socket） |
| `MREmu/Path.cpp` | 路径映射 `A:\x` → `./fs/a/x` | 🟠 中（要指到 MEMFS/IDBFS） |
| `MREmu/MREngine/Audio*.cpp` | `sf::SoundStream` + ADLMIDI、录音 | 🟠 中（WebAudio 解锁、录音不可用） |

---

## 2. 三个必须理解的运行机制

### 2.1 双线程：UI 60fps / 模拟器事件循环

`MREmu.cpp:146` 是 UI 线程的 `while (win_device.isOpen())`，每帧：`pollEvent` → `graphic.update_screen()`
→ `device.draw()` → `display()`。

`AppManager::start()`（`AppManager.cpp:316`）另起一个线程跑 `loop()`：一个带
`condition_variable` 的**事件泵**——等事件（启动/输入/系统消息/网络）+ 等最近一个定时器到期，
然后同步调用 `app->run(...)` 进入 ARM 代码（`uc_emu_start(entry, idle_p, 0, 0)`，跑到"返回蹦床"为止）。

> 这个模型对 Web 其实很友好：模拟器本身是**协作式**的，不是死循环。真正的难点只有"UI 线程在浏览器里不能让出"。

### 2.2 内存模型：guest 地址 = 宿主指针

`Memory::init()` 申请 32MB，`shared_memory_offset = (uint64_t)ptr - 0`，
于是 `ADDRESS_TO_EMU(ptr)` 就是指针值本身；`uc_mem_map_ptr()` 把这 32MB 整块映射进 guest。
**这条在 wasm32 上天然成立**（指针就是线性内存偏移，也是 32 位），所以这块几乎不用改。
唯一要注意：`_aligned_malloc(size, 0x1000000)`（16MB 对齐）在 wasm 堆里纯属浪费，已被补丁改成 4KB。

### 2.3 guest↔host 调用桥

`Bridge::init()` 在共享内存里铺了 `N` 条两字节的 ARM 指令 `BX LR` 当"函数蹦床"，每条的地址对应一个
MRE API；再用 `UC_HOOK_CODE` 监视这一地址区间，命中就执行宿主 C++ 函数（`Bridge.cpp:522 bridge_hoock`）。
所以是**每条模拟指令都要过 hook** 的 —— 这一点会放大 TCI 解释器的开销。

---

## 3. 上游已经有的 Web 基础（重要情报）

这不是我猜的，是仓库里现成的：

1. **`CMakeLists.txt:31` 有完整 `if(EMSCRIPTEN)` 块**：`-pthread`、`-sPTHREAD_POOL_SIZE=4`、
   `-sASYNCIFY=1`、`-sFULL_ES2=1`、`-sMIN/MAX_WEBGL_VERSION=1`、`-sFORCE_FILESYSTEM`、
   `--preload-file .../fs@/fs`。
2. **`deps/CMakeLists.txt:13`**：emscripten 下不再用子模块，改为 FetchContent 拉
   - `Zombieschannel/SFML` @ `52b08b0`（分支 `2.6.x-EMCC`，即 **SFML 2.6 的 Emscripten 移植版**）
   - `XimikBoda/unicorn` @ `854ddf8`
   并链接 `$EMSDK/upstream/emscripten/cache/sysroot/include/AL`（说明音频走 Emscripten 自带的 OpenAL→WebAudio）。
3. **那个 Unicorn fork 的提交信息直接写着**：
   > `Added emscripten support` — *Changes based on https://github.com/AlexAltea/unicorn.js*

   改动要点（我核对过 diff）：
   - `set(UNICORN_TARGET_ARCH "tci")`，编 `qemu/tci.c`
   - 新增 `emscripten/config-host.h`：`#define CONFIG_TCG_INTERPRETER 1`
   - 新增 `emscripten/config-target.h`：`TARGET_ARM 1` + `CONFIG_SOFTMMU`
   - 全局加 `-sSUPPORT_LONGJMP=emscripten`（QEMU 的 `sigsetjmp` 异常路径需要）

   → **这意味着"浏览器里跑 ARM"这一步已经被攻破了**：用 TCI 逐条解释 TCG 中间码，不需要 JIT。
4. 还有一条历史分支 `refs/heads/Emscripten`（commit `1d14940 Added base emscripted support`）。
   它比当前 master 早了多次重构（diff 有 2880+/2262-，那时 `MREngine::Graphic` 还没合并、
   `Path/Tags` 结构不同、`Network` 还没抽出来），**只能当思路参考，不能直接 merge**。

**所以真正的问题不是"能不能"，而是"最后一公里"：**

| 缺口 | 现象 |
|---|---|
| 没导出任何 C 符号 | JS 无法把 VXP 递给模拟器（原设计只有命令行 `argv[0]` 或 Android JNI） |
| `--preload-file bin/Release/fs` | 该目录在源码树里不存在，configure 就会报错 |
| 主循环阻塞 | `while(win.isOpen())` 依赖 SFML-EMCC 在 `display()` 里 `emscripten_sleep` 让出；若没实现则整页卡死 |
| `fs::current_path(argv[0])` | wasm 下 `argv[0]` 是虚拟值，可能抛异常 |
| asio 网络 | 浏览器没有 raw socket，运行期必然失败（不影响编译） |
| `sf::SoundRecorder` | 需要 `getUserMedia`，WebAudio 没这条路 |

---

## 4. 硬约束矩阵（决定架构的那几条）

| 子系统 | 桌面做法 | 浏览器限制 | 本方案对策 |
|---|---|---|---|
| 线程 | `std::thread` × 2 | 需要 **SharedArrayBuffer**，页面必须 `crossOriginIsolated` （COOP+COEP 响应头） | 保留双线程；本地用 `serve.py` 发头；静态托管用 `coi-serviceworker.js` 兜底 |
| 渲染 | SFML/OpenGL，任意线程调用 | GL 调用只能在**有上下文的线程**；canvas 默认在 window 线程 | 渲染留在 window 线程，模拟线程只写共享内存像素（现有架构天然满足） |
| 内存 | `mmap` 指针 | 无 `mprotect`、无 JIT | 已有：32MB 一次性静态池 + Unicorn `uc_mem_map_ptr` |
| CPU | Unicorn TCG **JIT** | 禁止运行时生成机器码 | 已解决：TCI **解释器**（慢，但可用） |
| 文件 | `std::filesystem` | MEMFS（内存）/ IDBFS（IndexedDB 持久化） | `base_path = /mre`（IDBFS 挂载点），已打补丁 |
| 网络 | asio TCP/UDP | 无 raw socket；只有 fetch/WebSocket/WebRTC | v1 全部返回错误；v2 加 WebSocket 中继（见 §8.3） |
| 音频 | OpenAL + MIDI 合成 | WebAudio，**必须用户手势后解锁**；`AudioContext` 受自动播放策略限制 | 保留 SFML 音频（Emscripten OpenAL 会桥到 WebAudio），加首帧 `resume()`；录音桩掉 |
| 输入 | 鼠标/键盘 | 触屏 + Pointer Events | 现有 `Device/Touch`、`Device/Keyboard` 只依赖 SFML 事件，移植版会转成 `sf::Event`，**几乎零成本** |
| 字体 | 系统字体 | 无系统字体 | 项目本来就**不用 `sf::Font`**，全是自带 unifont 位图（`MREngine/unifont.h`）——天生适合 Web ✅ |

---

## 5. 目标架构

```
┌─ 浏览器主线程 (window) ────────────────────────────────────────────┐
│  mremu_shell.html                                                  │
│   ├─ <canvas id="canvas">  ← SFML(WebGL1) 直接画这里               │
│   ├─ 工具栏：选文件 / 全屏 / 日志 / 软键盘                          │
│   ├─ File/拖拽 → FS.writeFile('/mre/fs/e/x.vxp')                   │
│   └─ Module.ccall('mremu_push_vxp', path)  ← 只入队，立刻返回       │
│                                                                    │
│  Module main()  ──►  while(win.isOpen()) {pollEvent; draw; sleep}   │
└──────────────┬─────────────────────────────────────────────────────┘
               │ SharedArrayBuffer（pthreads）
┌──────────────▼─────────────────────────────────────────────────────┐
│ Web Worker（= std::thread）                                        │
│  AppManager::loop()                                                │
│    cv.wait_for(最近定时器) → 取事件 → App::run()                    │
│        └─ Bridge → uc_emu_start(ARM Thumb)  【Unicorn TCI 解释】    │
│              └─ UC_HOOK_CODE 命中蹦床 → 宿主 vm_* 实现              │
└────────────────────────────────────────────────────────────────────┘
```

---

## 6. 分阶段路线

### P0 —— 让它编译出 `MREmu.wasm`（半天~2天，主要是环境）

准备工作：
1. 装 emsdk（`./emsdk install latest && ./emsdk activate latest`）
2. **装 MRE SDK 3.0 头文件**（`deps/mresdk` 不是子模块，只吃 `include/vm*.h`）：
   下载 `MRE_SDK_3.0.00.20_Normal_Eng.zip` → 安装到如 `C:\MRE_SDK` → `export MRE_SDK=/c/MRE_SDK`
3. 拉子模块（SFML/unicorn 走 FetchContent 不用拉，其余要）：
   `deps/libiconv-cmake deps/libADLMIDI deps/spdlog deps/asio.cmake deps/miniz deps/mresdk`

改动（**已由 `apply_web_patch.py` 自动完成**）：
- 根 `CMakeLists.txt`：整块重写 `if(EMSCRIPTEN)` 链接参数（见下方 diff 摘要）
- `MREmu/CMakeLists.txt`：加入 `WebBridge.cpp`
- `MREmu/MREmu.cpp`：`fs::current_path(argv[0])` 在 wasm 下跳过
- `MREmu/Memory.cpp`：16MB 对齐 → 4KB
- `MREmu/Path.cpp`：`base_path` → `/mre`

验收：`cmake --build` 通，`bin/MREmu.js` + `MREmu.wasm` 产出，`wasm-objdump -h` 能看到 memory/imports。
常见坑：
- `-sALLOW_MEMORY_GROWTH` 必须**关掉**（多线程下增长会让 SAB detach，且 Unicorn 绑定的指针会失效）→ 改用固定 256MB
- `-flto` 与 emscripten + pthreads 组合容易出玄学错误，先别开
- `libiconv` 若与 emlibc 冲突：给 emscripten 分支加 `-DLIBICONV_PLUG`（已有）或直接换 `-sUSE_ICU`

### P1 —— 浏览器里看见设备屏幕（1~3天）

要人工做的（脚本不敢自动改的部分）：
1. **主循环让出 CPU**（最关键）
   优先方案：确认 SFML `2.6.x-EMCC` 的 `sf::Window::display()` 里调用了 `emscripten_sleep(0/1)`；
   有的话维持现有 `while` 循环 + `-sASYNCIFY` 即可，什么都没改就活了。
   没有的话改成 `emscripten_set_main_loop`：

   ```cpp
   #ifdef __EMSCRIPTEN__
       // 把 while 循环体抽成 frame()，用 set_main_loop 驱动（rAF 节奏）
       emscripten_set_main_loop_arg([](void* p) { frame(); }, nullptr, 0, true);
   #else
       while (win_device.isOpen()) frame();
   #endif
   ```
2. **确认 canvas 拿到事件**：SFML-EMCC 会监听 `#canvas` 的 pointer/keyboard；若只绑了 `window`，在 shell 里转发。
3. **首次用户手势解锁音频**（shell 里已做 `pointerdown → AudioContext.resume()`）。

验收：打开页面浮出 240×320 的黑屏设备 + 软键盘；控制台 `crossOriginIsolated === true`。

### P2 —— 跑通第一个 VXP（1天 + 调优）

流程已在 shell 里打通：`选文件/拖拽 → FS.writeFile('/mre/fs/e/*.vxp') → syncfs → mremu_push_vxp()`。

要补的：
- `Graphic::screenshot()`：`im.saveToFile()` 落在 MEMFS，加个 JS 侧"下载"按钮把它导出成 PNG
- 存档持久化：`Module.FS.syncfs()` 在关键时机调用（切 App/退出时）
- 错误可见性：`show_error/error_message` 目前只在 imgui 里显示（wasm 下 `DEBUG_WINDOW=OFF`）→ 改成 `spdlog::error` + shell 日志面板

验收：随便挑个离线小游戏，能点、能出画面、有声音、能退出。

### P3 —— 体验与联网（1~2周，按需）

- **性能**：见 §7
- **联网**：见 §8.3
- **PWA**：加 manifest + 离线缓存 wasm，手机上"添加到主屏幕"全屏玩
- **多实例**：每个 `<canvas>` 一个 wasm 实例（注意内存 256MB/实例，iOS 会杀）

---

## 7. 性能预估与提质路线

| 环节 | 开销 | 缓解 |
|---|---|---|
| ARM 指令解释（TCI） | **主要成本**，约为 JIT 的 1/10~1/30 | 见下 |
| 每条指令的 `UC_HOOK_CODE`（蹦床区） | 只在调用 host API 时命中，可接受 | 保持蹦床区间最小 |
| 帧上传 240×320 RGB565→RGBA | 307KB/帧转换 | 已经只在 `screen_changed` 时做；可改 `UNSIGNED_SHORT_5_6_5` 纹理直传 |
| 音频 | SFML SoundStream 线程 + OpenAL | 保持；MIDI 合成（ADLMIDI）在 wasm 里会慢，考虑降采样 |

如果把性能做上去，按性价比排序：

1. **减少 hook 命中**：把 `UC_HOOK_CODE` 换成 `UC_HOOK_BLOCK`/地址区间更窄，或改成"扫描 PC 是否在蹦床区"的内联判断。
2. **换 CPU 后端**：Unicorn 的 TCI 是最慢的那档。可选：
   - 自己写一个 ARMv5TE 解释器（这个平台的指令集很小，业界常见做法，能比 TCI 快 2~5 倍）
   - 用 **Wasm 动态生成**（把 ARM 基本块翻译成 wasm 函数，`WebAssembly.Module` 编译）——最强但工程量最大
3. **降帧**：MRE 游戏普遍 15~30fps 也能玩，把 UI 循环从 60 降到 30，省渲染与主线程时间。

---

## 8. 风险与对策

### 8.1 SFML 的 Emscripten 移植版是"第三方半维护"
`Zombieschannel/SFML` 的 `2.6.x-EMCC` 分支不等于官方支持度。本项目用到的 SFML 面很窄
（`RenderWindow/Event/Texture/Sprite/View/Clock/SoundStream/Music` + 少量 `RectangleShape/Color`），
所以**兜底方案**是：写一个 ~600 行的"mini-SFML"（Canvas2D 或 WebGL 直接 blit 一张纹理 + 手写事件映射），
只实现这十几个类型。工作量可控，且彻底摆脱移植版的坑。**判断标准**：若 P1 阶段被移植版卡超过 2 天，就切这个方案。

### 8.2 ASYNCIFY × pthreads 的组合有雷
`ASYNCIFY` 只对主线程生效，且会让代码体积/开销上升；worker 线程里的 `uc_emu_start` 长时间不返回时，
主线程仍能跑（好），但**从 JS 调进 wasm 的导出函数必须是"微秒级返回"的**——`mremu_push_vxp` 只入队，符合要求。

### 8.3 联网：浏览器没有 raw socket
MRE 应用用 `vm_tcp_connect/read/write`、`vm_udp_*`（`MREngine/Sock.cpp`，asio 异步实现）。

**v2.1（新增）：边缘函数做转发——可行，且已产出可部署实现**（`edge-relay/worker.js`）：

```
MRE 应用(vm_tcp_*) → TcpSock(WS 版) → wss://edge-relay/?token=..
    → Cloudflare Worker：校验白名单/令牌 → connect()(cloudflare:sockets) 出站 TCP
    → 双向透传（WS binary 消息 = TCP 字节流）→ 回传 web
```

**平台判定矩阵**（"edge function 能不能既当 WS 服务端、又能出站 raw TCP"是关键）：

| 平台 | WS 服务端 | 出站 TCP | 出站 UDP | 结论 |
|---|---|---|---|---|
| Cloudflare Workers | ✅ | ✅ `cloudflare:sockets` | ❌ | **推荐**（免费档够用） |
| Deno Deploy | ✅ | ✅ `Deno.connect` | ❌ | 可行 |
| Vercel Edge Functions | ❌ | ❌ | ❌ | 不可行（纯 fetch，无 WS 服务端） |
| 自建 VPS + websockify | ✅ | ✅ | ✅ | 功能最全，需自己运维 |

**两个硬边界**：
1. **UDP 没戏**——主流边缘函数都没有出站 UDP，`vm_udp_*` 只能保持返回错误，
   或给真服务器加 UDP 中继（联机对战类应用才需要）；
2. **安全**——边缘 TCP 转发本质是公网跳板，必须配 `ALLOW_HOSTS` 白名单 + 连接令牌，
   端口 25 硬禁（Worker 代码里已做）。

**两条实现路线**（`edge-relay/README.md` 有细节）：
- **路线 A（最小改动，待真机验证）**：开 `-sPROXY_POSIX_SOCKETS`，复用 Emscripten 自带的
  "POSIX 系统调用桥"（`tools/websocket_to_posix_proxy/`——注意它不是 websockify 字节流，
  而是把 socket()/connect()/send()/recv() 编码成消息过 WS）。Sock.cpp **零改动**，
  但要在 Worker 里复刻整套 syscall 桥协议，且它连 DNS（getaddrinfo）也走代理。
- **路线 B（推荐）**：`TcpSock::connect/read/write/close` 在 `__EMSCRIPTEN__` 下直接换
  `emscripten_websocket_*` 实现（~150 行）：WS 连 `wss://edge-relay/?token=..`，
  首条控制帧带目标 `[0x01][port:2B][host]`，之后 binary 消息透传；
  收到的数据进环形缓冲喂 `read()`，就绪事件照旧 `push_event(VM_TCP_EVT_*)`。
  `resolver.async_resolve` 整段跳过（DNS 由边缘函数做）。`UdpSock` 维持返回错误。

> 路线 B 的 C++ 代码是 P3 待办：需要先把 `edge-relay` 部署到 Cloudflare 后真机联调，
> 本地无头环境无法构造真实的 WS→TCP 链路。

其他路线（保留备查）：
1. **v1：全部失败返回**（`VM_E_SOC_ERROR`）。绝大多数单机游戏无感。
2. **v2：WebSocket 中继**。宿主侧跑个小服务（Node/Go），浏览器 `WebSocket` ↔ 服务端 `net.connect()`，
   在 `Sock.cpp` 里加一个 `WebSocketTcpSock` 实现即可（接口与 `TcpSock` 一致，`async_wait` 用 JS 回调模拟）。
3. **v3：WebRTC DataChannel**（等效 UDP），适合联机对战型应用，但要信令服务器。

> 不要试图用 Emscripten 的 `-sPROXY_POSIX_SOCKETS`：它要求一个 WebSocket 代理且只支持 TCP，
> 维护成本比自己写一层 WebSocket 客户端还高。（若走 v2.1 路线 A 则除外——它的协议桥在
> `tools/websocket_to_posix_proxy/` 里有现成 C 参考实现，可以照着翻译成 Worker。）

### 8.4 其他小坑
- `-sSTACK_SIZE=5mb`：Unicorn TCI + 递归 hook 很深，默认 64KB 会爆栈
- `PTHREAD_POOL_SIZE` 要给够（`Network` 线程 + `AppManager` 线程 + SFML 音频线程 + 潜在的文件线程）
- iOS Safari：单页 wasm 内存上限紧，256MB 是保守值；不要开多个实例
- 首次加载体积：实测 `MREmu.wasm` 仅 **6.9MB**（gzip 后更小），比预估乐观得多

### 8.5 已知问题（实测发现）
- **部分 VXP 抛 `UC_ERR_EXCEPTION`**：`HelloWorld.vxp`（mtk-gcc 样例）在 PC=0x340F4 触发
  `uc_emu_start returned 21`，而 `Game2048.vxp` 正常。怀疑是 TCI 配置（`config-host.h` 里
  `HOST_I386`/`CONFIG_INT128`）或 ARMv5TE 个别指令（如 `BLX`/`LDRD`/协处理器）在解释器路径的行为差异。
  排查顺序：先在桌面版（JIT）跑同一个 VXP 确认是否移植引入 → 若是，抓 `UC_HOOK_CODE` 附近指令流
  对比 TCI 与 JIT 的翻译结果。这是后续最主要的技术债。
- **工具栏遮挡**：画布 240×528 在小窗口下会顶到工具栏，shell 已加 `#stage{padding:60px 0}`，可按需调。
- **游戏资源路径**：`/mre/fs/e/mythroad/system/gb16.uc2` 这类字体资源需要用户自己放进
  "e 盘"（浏览器里就是 IDBFS 的 `/mre/fs/e/`），否则中文文字渲染缺字（截图里菜单文字正常，
  说明游戏内嵌字体可用）。

---

## 9. 本目录已交付的东西

```
web-port/
├── MREmu-Web移植方案.md          ← 本文
├── apply_web_patch.py            ← 补丁脚本（git apply + overlay，已在干净克隆验证）
├── build_web.sh                  ← 一键构建（emsdk → cmake → ninja → web/dist）
├── patches/
│   ├── 0001-mremu-web-port.patch ← 对已跟踪文件的全部修改（git diff 导出）
│   └── overlay/                  ← 新增文件：WebBridge.cpp、shell.html、char_traits_shim.h、
│                                    coi-serviceworker.js、serve.py
├── src/WebBridge.cpp             ← 同 overlay（源码备份）
└── web/
    ├── shell.html                ← 自定义 emscripten shell（canonical 版本在 patches/overlay）
    ├── coi-serviceworker.js      ← 静态托管下补 COOP/COEP
    ├── serve.py                  ← 本地调试服务器（COOP/COEP + 正确 MIME）
    └── dist/                     ← 最新一次构建产物（index.html + MREmu.js/.wasm）
```

已在 `../repo` 生效的改动（`git diff --stat`，对上游 master `8c7af51`）：

```
 CMakeLists.txt          | 修改 emscripten 链接参数块（线程/内存/IDBFS/shell/导出）
 MREmu/CMakeLists.txt    | +WebBridge.cpp、emscripten 下输出 .html
 MREmu/MREmu.cpp         | wasm 下跳过 fs::current_path(argv[0])
 MREmu/Memory.cpp        | 16MB 对齐 → 4KB
 MREmu/Path.cpp          | base_path → /mre（IDBFS 挂载点）
 MREmu/App.cpp           | 非 Windows 补 <unistd.h>
 MREmu/MREngine/Audio.cpp| include vmmissing.h（C 链接）
 deps/mresdk/vmmissing.h | 补 vm_get_volume 声明（SDK 3.0.00.03 缺）
 新增：MREmu/WebBridge.cpp（mremu_ready / mremu_push_vxp）、web/shell.html、
       web/char_traits_shim.h、web/coi-serviceworker.js、web/serve.py
```

回滚：`python apply_web_patch.py --revert`。

---

## 10. 怎么跑（已验证的完整流程）

```bash
# 0) 工具链（一次性）
git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
cd emsdk && python emsdk.py install latest && python emsdk.py activate latest
export PATH="$PWD/emsdk/upstream/emscripten:$PWD/emsdk:$PATH"      # 或 source emsdk_env.sh
pip install "cmake==3.29.6" ninja                                  # 或用 emsdk 自带
export MRE_SDK="/path/to/MRE_SDK"         # 目录下要有 include/vmsys.h

# 1) 构建（一键：打补丁 → configure → build → 收集到 web/dist）
bash web-port/build_web.sh Release

# 2) 本地验证（必须带 COOP/COEP 头的服务器）
cd web-port/web/dist && python serve.py 8080
#   浏览器开 http://localhost:8080/ ，把 .vxp 拖进页面
```

验证清单（全部已实测通过）：
- [x] `crossOriginIsolated === true`（pthreads 前提）
- [x] 控制台/日志面板出现 `[boot] 模拟器就绪`
- [x] 页面出现 240×320 设备画面 + 软键盘（SFML/WebGL 正常）
- [x] 加载 VXP → ARM 应用跑起来（Game2048 完整可玩，见截图）
- [x] `[idbfs] 已恢复本地文件`（IndexedDB 持久化）
- [ ] 声音（headless 里验证不了，需真机浏览器点击页面后确认）

---

## 10.5 静态托管部署（无 COOP/COEP 响应头的场景）✅ 已实测

pthreads 版 wasm 需要 SharedArrayBuffer，而 SAB 只在跨源隔离页面可用——但**跨源隔离不一定要服务器配置，
Service Worker 也能补上响应头**。这套机制已经内置并实测通过（用不带任何跨源头的
`python -m http.server` 模拟静态托管，Game2048 正常运行）：

**原理**（`web/coi-serviceworker.js` + shell 自动接线）：
1. 页面加载时检测 `crossOriginIsolated === false`；
2. 先把 wasm 实例化挂起（`Module.instantiateWasm` 返回 pending Promise），避免在未隔离状态下报
   "SharedArrayBuffer is not defined"；
3. 注册 `coi-serviceworker.js`：SW 接管所有**同源** fetch，给每个响应补上
   `COOP: same-origin` + `COEP: require-corp` + `CORP: cross-origin`（导航请求强制 `cache: 'reload'`，
   防止命中没带头的老缓存）；
4. 注册成功后整页刷新一次（sessionStorage 防刷新循环）；刷新后 `crossOriginIsolated === true`，
   wasm 正常启动；若仍未隔离（CDN 缓存了旧页面）会给出明确报错并引导强刷。

**部署方法**：把 `web/dist/` 里的文件原样传到任意支持 **HTTPS + Service Worker** 的静态托管即可
（GitHub Pages / Gitee Pages(需实名) / Netlify / Cloudflare Pages / 对象存储+CDN 都可以）。
首次访问会自动刷新一次（一闪而过），之后正常。

**注意事项**：
- 必须 **HTTPS**（或 localhost）——Service Worker 的硬性要求；`file://` 双击打开不行
- 页面引用的所有资源都应是**同源**的（本页只有 index.html/MREmu.js/MREmu.wasm，天然满足）；
  如果以后要加载跨域字体/图片，对方必须带 CORS 或 CORP 头
- iOS Safari 15.2+ 支持 COOP/COEP；更老的移动浏览器会卡在报错提示（无法隔离），届时只能做单线程版
- SW 作用域 = 其所在目录，`dist` 整体放在一个子目录里部署没问题

**如果托管其实支持自定义响应头**（很多"静态托管"其实支持，只是不易发现），优先直接配头，比 SW 更稳：
- Nginx：`add_header Cross-Origin-Opener-Policy same-origin;` + `add_header Cross-Origin-Embedder-Policy require-corp;`
- Netlify / Cloudflare Pages：根目录放 `_headers` 文件
- Vercel：`vercel.json` 的 `headers` 字段
- GitHub Pages：不支持配置头 → 只能用本方案（SW）

---

## 10.6 PWA 适配（安装到桌面 + 双击 VXP 直接运行）✅ 已实测

**manifest.json**（传统文件名，与 index.html 同目录）关键字段：
```json
{
  "icons": [{ "src": "ic_calculator-one.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
            { "src": "icons/icon-512.png", "sizes": "512x512", "purpose": "any maskable" }],
  "file_handlers": [{ "action": "./index.html",
                      "accept": { "application/octet-stream": [".vxp", ".mrp"] },
                      "launch_type": "single-client" }],
  "launch_handler": { "client_mode": "navigate-new" }
}
```
- **图标**：`ic_calculator-one.svg` 来自字节 IconPark（calculator-one，outline 风格）。
  页内用的是浅色描边副本（原文件 `stroke="#333"` 在深色主题下看不清）；另用
  `tools/gen_icons.js`（无头 Edge 截图）栅格化出 512/192 PNG，512 带暗底并留 maskable 安全区。
- **双击 VXP 启动**：安装后 Windows 会把 `.vxp/.mrp` 关联到应用；系统"打开方式"打开时，
  `launchQueue.setConsumer` 收到文件句柄 → 若尚未就绪先存 `Boot.pendingFile`，就绪后自动导入运行。
  `client_mode: "navigate-new"` 保证**每次双击都开一个新窗口**（多开互不干扰）。
- **安装入口**：地址栏安装图标，或页面出现 `beforeinstallprompt` 时工具栏里的「安装」按钮。
- **实测注意**：File Handling 是 Chromium 桌面特性（Edge/Chrome 安装后才生效，无头环境无法端到端验证
  系统关联，但 `launchQueue` 接收与自动运行逻辑已验证）；iOS Safari 不支持 file_handlers。
- **自绘控件**：文件下拉面板和确认弹窗都是网页自绘（`#lib-menu` / `#modal`），不再用 `<select>` 和
  `window.confirm`，各端观感一致；Esc/点遮罩均可取消。
- **文件库存储（重要）**：已导入的 VXP 存在**自建 IndexedDB 库 `mremu-lib`**（逐文件 put/delete），
  不存在 IDBFS 里。原因：IDBFS 的"本地→远程"同步会删除远程中本地没有的条目，而 `navigate-new`
  每次双击都开新窗口，旧窗口的过期快照一同步就把新导入的文件"修剪"掉（Bug 表现为"只剩最近
  打开的一两个"）。`/mre/fs/e/` 里的文件只是运行时视图：页面启动时（`restoreAll`）和启动应用前
  （`launch → materialize`）都会从自建库重新物化，被竞态弄丢也会自愈。本模拟器只支持 `.vxp`，
  manifest 的 file_handlers 和界面均不再接受 `.mrp`。

---

## 11. 结论与建议

1. **建议做**，但把它当成"给 MREmu 加一个平台后端"，而不是"重写一个网页模拟器"——
   主体（CPU/内存/桥接/引擎）约 1.5 万行可以 100% 复用。
2. **优先级**：先确认 SFML-EMCC 能否撑住（P1 的 2 天），这决定了整个方案是"改配置级"还是"写后端级"。
3. **别一上来啃性能**。TCI 能跑起来就已经赢了，性能优化（甚至换 CPU 后端）放到 P3。
4. 向上游提 PR 是划算的：作者显然在做同一件事（`Emscripten` 分支 + unicorn fork + CMake 参数），
   互通有无比另起炉灶强。建议把 `WebBridge.cpp` + shell + 修好的链接参数打包成 PR。

**预计总工时**：能跑第一个游戏 ≈ 3~5 个工作日；做到"可分享的网页版" ≈ 2~3 周（含性能调优与联网）。
