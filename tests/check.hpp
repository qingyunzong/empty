#pragma once

#include <cstdio>
#include <cstdlib>

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__,    \
                         __LINE__, #cond);                                   \
            std::fflush(stderr);                                             \
            std::exit(1);                                                    \
        }                                                                    \
    } while (0)

#define PASS(name)                    \
    do {                              \
        std::printf("PASSED: %s\n", name); \
        return 0;                     \
    } while (0)
