#pragma once

#include <cstdio>

// Minimal dependency-free test assertions; each test binary has its own main
// and returns non-zero on failure so CTest can pick it up.
namespace test {

inline int& failure_count() {
    static int count = 0;
    return count;
}

inline void report(const char* file, int line, const char* expr) {
    ++failure_count();
    std::fprintf(stderr, "FAIL %s:%d: CHECK(%s)\n", file, line, expr);
}

inline int summarize(const char* name) {
    if (failure_count() == 0) {
        std::printf("PASS %s\n", name);
    } else {
        std::printf("FAIL %s (%d failed checks)\n", name, failure_count());
    }
    return failure_count() == 0 ? 0 : 1;
}

} // namespace test

#define CHECK(cond)                                                                            \
    do {                                                                                       \
        if (!(cond)) {                                                                         \
            ::test::report(__FILE__, __LINE__, #cond);                                         \
        }                                                                                      \
    } while (0)
