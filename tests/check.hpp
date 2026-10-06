#pragma once

#include <cstdio>

namespace tinytest {
inline int& checks() {
    static int c = 0;
    return c;
}
inline int& failures() {
    static int f = 0;
    return f;
}
}  // namespace tinytest

#define CHECK(cond)                                                     \
    do {                                                                \
        ++tinytest::checks();                                           \
        if (!(cond)) {                                                  \
            ++tinytest::failures();                                     \
            std::fprintf(stderr, "FAIL %s:%d: CHECK(%s)\n", __FILE__,   \
                         __LINE__, #cond);                              \
        }                                                               \
    } while (0)

#define TEST_SUMMARY(name)                                              \
    do {                                                                \
        std::fprintf(stderr, "%s: %d checks, %d failures\n", name,      \
                     tinytest::checks(), tinytest::failures());         \
        return tinytest::failures() == 0 ? 0 : 1;                       \
    } while (0)
