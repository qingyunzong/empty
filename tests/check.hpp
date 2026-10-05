#pragma once
#include <cstdio>
#include <cstdlib>

inline int g_failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__,   \
                         #cond);                                           \
            ++g_failures;                                                  \
        }                                                                  \
    } while (0)

#define CHECK_MSG(cond, ...)                              \
    do {                                                  \
        if (!(cond)) {                                    \
            std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
            std::fprintf(stderr, __VA_ARGS__);            \
            std::fprintf(stderr, "\n");                   \
            ++g_failures;                                 \
        }                                                 \
    } while (0)

#define TEST_MAIN()                                        \
    int main() {                                           \
        run();                                             \
        if (g_failures == 0) {                             \
            std::printf("ALL CHECKS PASSED\n");            \
            return 0;                                      \
        }                                                  \
        std::printf("%d CHECK(S) FAILED\n", g_failures);   \
        return 1;                                          \
    }
