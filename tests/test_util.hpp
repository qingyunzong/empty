#pragma once

#include <cstdio>

namespace test {

inline int& failures() {
    static int n = 0;
    return n;
}

inline int summary(const char* name) {
    if (failures() == 0) {
        std::printf("[PASS] %s\n", name);
        return 0;
    }
    std::printf("[FAIL] %s: %d check(s) failed\n", name, failures());
    return 1;
}

}  // namespace test

#define CHECK(...)                                                         \
    do {                                                                   \
        if (!(__VA_ARGS__)) {                                              \
            std::fprintf(stderr, "  CHECK failed %s:%d: %s\n", __FILE__,   \
                         __LINE__, #__VA_ARGS__);                          \
            ++test::failures();                                            \
        }                                                                  \
    } while (0)
