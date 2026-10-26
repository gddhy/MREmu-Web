// web/char_traits_shim.h
//
// SFML 2.6 的 sf::String 内部用 std::basic_string<sf::Uint32 / Uint16 / Uint8>，
// 这在 MSVC / libstdc++ 上能编过（它们对整型 char_traits 有兜底），
// 但 Emscripten 用的 libc++ **只**为 char/wchar_t/char8_t/char16_t/char32_t
// 定义了 std::char_traits，于是：
//   error: implicit instantiation of undefined template 'std::char_traits<unsigned int>'
//
// 这里补上整型特化，用 -include 强制注入到所有 C++ 编译单元。
// 注意：本文件必须保持 **C++98 兼容**——libADLMIDI 是按 -std=gnu++98 编译的，
// 用了 auto/using 别名/noexcept 会把它带崩。

#pragma once

#include <cstddef>
#include <cwchar>
#include <ios>
#include <string>

namespace std {

template <typename T>
struct mremu_integer_char_traits {
    typedef T char_type;
    typedef unsigned int int_type;
    typedef std::streamoff off_type;
    typedef std::streampos pos_type;
    typedef std::mbstate_t state_type;

    static void assign(char_type& r, const char_type& a) { r = a; }

    static char_type* assign(char_type* p, std::size_t n, char_type a) {
        for (std::size_t i = 0; i < n; ++i)
            p[i] = a;
        return p;
    }

    static bool eq(const char_type& a, const char_type& b) { return a == b; }
    static bool lt(const char_type& a, const char_type& b) { return a < b; }

    static int compare(const char_type* s1, const char_type* s2, std::size_t n) {
        for (std::size_t i = 0; i < n; ++i) {
            if (lt(s1[i], s2[i])) return -1;
            if (lt(s2[i], s1[i])) return 1;
        }
        return 0;
    }

    static std::size_t length(const char_type* s) {
        std::size_t n = 0;
        while (!eq(s[n], char_type(0))) ++n;
        return n;
    }

    static const char_type* find(const char_type* s, std::size_t n, const char_type& a) {
        for (std::size_t i = 0; i < n; ++i)
            if (eq(s[i], a)) return s + i;
        return 0;
    }

    static char_type* move(char_type* d, const char_type* s, std::size_t n) {
        if (d < s) {
            for (std::size_t i = 0; i < n; ++i) d[i] = s[i];
        } else if (d > s) {
            for (std::size_t i = n; i-- > 0;) d[i] = s[i];
        }
        return d;
    }

    static char_type* copy(char_type* d, const char_type* s, std::size_t n) {
        for (std::size_t i = 0; i < n; ++i) d[i] = s[i];
        return d;
    }

    static char_type to_char_type(const int_type& c) { return static_cast<char_type>(c); }
    static int_type to_int_type(const char_type& c) { return static_cast<int_type>(c); }
    static bool eq_int_type(const int_type& a, const int_type& b) { return a == b; }
    static int_type eof() { return static_cast<int_type>(-1); }
    static int_type not_eof(const int_type& c) { return eq_int_type(c, eof()) ? int_type(0) : c; }
};

// 只特化 SFML 真正用到的三个（uint32_t 在 wasm 上就是 unsigned int，
// 重复特化会报"explicit specialization after instantiation"）
template <> struct char_traits<unsigned int>   : mremu_integer_char_traits<unsigned int>   {};
template <> struct char_traits<unsigned short> : mremu_integer_char_traits<unsigned short> {};
template <> struct char_traits<unsigned char>  : mremu_integer_char_traits<unsigned char>  {};

} // namespace std
