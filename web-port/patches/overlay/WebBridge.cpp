// MREmu/WebBridge.cpp
//
// 作用：把 "启动一个 VXP" 这件事暴露成 C 符号，供浏览器侧 JS 调用。
// 编译：无条件加入 MREmu/CMakeLists.txt 的 SOURCES 即可（非 emscripten 平台整个文件为空）。
//
// 用法（JS）：
//   const ptr = Module.stringToUTF8 ? ... ;
//   先 FS.writeFile("/mre/fs/e/game.vxp", bytes)
//   Module.ccall('mremu_push_vxp', 'number', ['string'], ["/mre/fs/e/game.vxp"]) 
//
// 注意：本函数只做「入队」，几十微秒返回。千万不要在这里做耗时操作——
// 它是在主线程（ASYNCIFY 暂停栈）里被调用的。

#include "AppManager.h"
#include "AppManagerEvents.h"

#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

extern "C" {

// 运行时是否已经准备好了（AppManager 已构造且 loop 线程已起）
EMSCRIPTEN_KEEPALIVE
int mremu_ready(void) {
    return AppManager::getPtr() ? 1 : 0;
}

// 让模拟器加载并运行一个 MEMFS/IDBFS 里的 VXP 文件
// 返回 0 成功，-1 未就绪，-2 参数非法
EMSCRIPTEN_KEEPALIVE
int mremu_push_vxp(const char* memfs_path) {
    if (!memfs_path || !memfs_path[0])
        return -2;

    AppManager* mgr = AppManager::getPtr();
    if (!mgr)
        return -1;

    Event::launch ev;
    ev.data = Event::path_app{ std::filesystem::path(memfs_path), false };
    mgr->push_event(ev);   // 内部有锁 + condition_variable，线程安全
    return 0;
}

} // extern "C"
#endif // __EMSCRIPTEN__
