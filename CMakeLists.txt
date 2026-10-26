cmake_minimum_required (VERSION 3.8)
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)

project ("MREmu")

# Enable Hot Reload for MSVC compilers if supported.
if (POLICY CMP0141)
  cmake_policy(SET CMP0141 NEW)
  set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "$<IF:$<AND:$<C_COMPILER_ID:MSVC>,$<CXX_COMPILER_ID:MSVC>>,$<$<CONFIG:Debug,RelWithDebInfo>:EditAndContinue>,$<$<CONFIG:Debug,RelWithDebInfo>:ProgramDatabase>>")
endif()

if(NOT EMSCRIPTEN AND NOT ANDROID)
    option(DEBUG_WINDOW "Turn on additional debugging windows" ON)
    option(BUILTIN_GDB "Turn on additional build-in GDB" OFF)
    option(CAPSTONE "Endble capstone" OFF)
else()
    set(DEBUG_WINDOW FALSE)
    set(BUILTIN_GDB FALSE)
    set(CAPSTONE FALSE)
endif()


set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/bin)

# Enable optimizations by default
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  message(STATUS "Setting build type to 'Release' as none was specified.")
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Choose the type of build." FORCE)
endif()

# ------------------------------------------------------------------ #
# Web (Emscripten) 构建配置 —— MREMU_WEB_PATCH
# ------------------------------------------------------------------ #
if(EMSCRIPTEN)
    add_compile_options(-pthread)

    # 两个关键取舍：
    #  1) 不能开 ALLOW_MEMORY_GROWTH。多线程下 wasm 内存增长会 detach SAB，
    #     而且 Unicorn 的 uc_mem_map_ptr 绑定的宿主指针必须整块稳定。
    #  2) SFML(2.6.x-EMCC) 的主循环靠 emscripten_sleep 让出，需要 ASYNCIFY。
    add_link_options(
        "-pthread"
        "-sPTHREAD_POOL_SIZE=8"
        "-sDEFAULT_PTHREAD_STACK_SIZE=2mb"
        "-sSTACK_SIZE=5mb"
        "-sINITIAL_MEMORY=268435456"
        "-sMAXIMUM_MEMORY=536870912"
        "-sUSE_OGG=1"
        "-sUSE_VORBIS=1"
        "-sEMULATE_FUNCTION_POINTER_CASTS=1"
        "-sSUPPORT_LONGJMP=emscripten"
        "-sASYNCIFY"
        "-sASYNCIFY_STACK_SIZE=524288"
        "-sFULL_ES2=1"
        "-sMIN_WEBGL_VERSION=1"
        "-sMAX_WEBGL_VERSION=1"
        "-sGL_EXPLICIT_UNIFORM_LOCATION=1"
        "-sGL_EXPLICIT_UNIFORM_BINDING=1"
        "-sFORCE_FILESYSTEM=1"
        "-sALLOW_TABLE_GROWTH=1"
        "-sWASM=1"
        # 不设 -sEXPORT_NAME：生成代码会去找"同名全局变量"当 Module 配置，
        # 我们的 shell 用的是经典 Module 对象
        "-sEXPORTED_FUNCTIONS=['_main','_mremu_ready','_mremu_push_vxp']"
        "-sEXPORTED_RUNTIME_METHODS=['FS','IDBFS','ccall','cwrap','UTF8ToString','stringToUTF8']"
        # 注：Emscripten 6 已移除 FS.filesystems，IDBFS 要从 Module.IDBFS 取
        "-lidbfs.js"        # /mre 挂到 IndexedDB，存档/刷新不丢
        "-sMINIFY_HTML=0"   # Release 默认会调 html-minifier-terser（emsdk 没装 node_modules）
    )

    # 脱敏：assert/__FILE__ 会把本机绝对路径（含系统账号名）编进 wasm，
    # 线上部署时等于把本地目录结构公开出去。用 -ffile-prefix-map 抹掉前缀。
    # 可用 -DMREMU_FILE_PREFIX_MAP=<目录> 指定要抹掉的根（build_web.sh 会传工作区根）
    if(DEFINED MREMU_FILE_PREFIX_MAP)
        add_compile_options("-ffile-prefix-map=${MREMU_FILE_PREFIX_MAP}=.")
    else()
        add_compile_options("-ffile-prefix-map=${PROJECT_SOURCE_DIR}=.")
    endif()

    # SFML 2.6 的 sf::String 用 std::basic_string<Uint32>，libc++ 没有对应 char_traits
    if(EXISTS "${PROJECT_SOURCE_DIR}/web/char_traits_shim.h")
        add_compile_options("$<$<COMPILE_LANGUAGE:CXX>:-include${PROJECT_SOURCE_DIR}/web/char_traits_shim.h>")
    endif()

    # 自定义 shell：canvas + 拖拽装 VXP + 日志面板
    if(EXISTS "${PROJECT_SOURCE_DIR}/web/shell.html")
        add_link_options("--shell-file" "${PROJECT_SOURCE_DIR}/web/shell.html")
    elseif(EXISTS "${PROJECT_SOURCE_DIR}/web/mremu_shell.html")
        add_link_options("--shell-file" "${PROJECT_SOURCE_DIR}/web/mremu_shell.html")
    endif()

    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
        add_compile_options(-g3)
        add_link_options("-g3" "-sASSERTIONS=2")
    else()
        add_compile_options(-O3)
        add_link_options("-O3" "-sASSERTIONS=0")
    endif()
endif()

add_definitions(-DLIBICONV_PLUG)
set(BUILD_SHARED_LIBS FALSE) 

add_definitions(-D_CRT_SECURE_NO_WARNINGS)

if (MSVC)
    add_compile_options(/wd4828)
    set(CMAKE_EXE_LINKER_FLAGS_DEBUG "${CMAKE_EXE_LINKER_FLAGS_DEBUG} /NODEFAULTLIB:LIBCMTD")
endif()

include_directories("include")

add_subdirectory (deps)

add_subdirectory (MREmu)

set_property(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR} PROPERTY VS_STARTUP_PROJECT MREmu)