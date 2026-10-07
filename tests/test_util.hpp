#pragma once
#include <cstdio>
#include <string>

namespace testutil {
inline int& failures() { static int f = 0; return f; }
inline int& checks() { static int c = 0; return c; }
} // namespace testutil

#define CHECK(cond)                                                            \
    do {                                                                       \
        ++testutil::checks();                                                  \
        if (!(cond)) {                                                         \
            ++testutil::failures();                                            \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
        }                                                                      \
    } while (0)

#define TEST_MAIN()                                                            \
    int main() {                                                               \
        run();                                                                 \
        std::fprintf(stderr, "%s: %d checks, %d failures\n",                   \
                     testutil::failures() == 0 ? "PASS" : "FAIL",              \
                     testutil::checks(), testutil::failures());                \
        return testutil::failures() == 0 ? 0 : 1;                              \
    }
