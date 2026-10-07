#pragma once

#include <cstdio>

namespace tst {

inline int& failures() {
    static int value = 0;
    return value;
}

inline void check(bool ok, const char* expr, const char* file, int line) {
    if (!ok) {
        ++failures();
        std::fprintf(stderr, "FAIL %s:%d: %s\n", file, line, expr);
    }
}

inline int summary() {
    if (failures() == 0) {
        std::puts("all checks passed");
        return 0;
    }
    std::fprintf(stderr, "%d check(s) failed\n", failures());
    return 1;
}

}  // namespace tst

#define CHECK(cond) ::tst::check(static_cast<bool>(cond), #cond, __FILE__, __LINE__)
