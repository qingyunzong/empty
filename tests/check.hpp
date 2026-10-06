#pragma once

#include <cstdio>
#include <iostream>

inline int g_failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            ++g_failures;                                                  \
            std::fprintf(stderr, "FAIL %s:%d: CHECK(%s)\n", __FILE__,      \
                         __LINE__, #cond);                                 \
        }                                                                  \
    } while (0)

#define CHECK_EQ(a, b)                                                          \
    do {                                                                        \
        auto va_ = (a);                                                         \
        auto vb_ = (b);                                                         \
        if (!(va_ == vb_)) {                                                    \
            ++g_failures;                                                       \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": " #a      \
                         " != " #b "\n  lhs = "                                 \
                      << va_ << "\n  rhs = " << vb_ << "\n";                    \
        }                                                                       \
    } while (0)

#define TEST_MAIN()            \
    int main() {               \
        run();                 \
        if (g_failures == 0) { \
            std::printf("OK\n"); \
            return 0;          \
        }                      \
        std::printf("%d failure(s)\n", g_failures); \
        return 1;              \
    }
