#pragma once
#include <cstdio>
#include <cstdlib>

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::fprintf(stderr, "CHECK failed %s:%d: %s\n", __FILE__,         \
                         __LINE__, #cond);                                      \
            std::exit(1);                                                      \
        }                                                                      \
    } while (0)

#define CHECK_EQ(a, b)                                                         \
    do {                                                                       \
        if (!((a) == (b))) {                                                   \
            std::fprintf(stderr, "CHECK_EQ failed %s:%d: %s == %s\n",          \
                         __FILE__, __LINE__, #a, #b);                          \
            std::exit(1);                                                      \
        }                                                                      \
    } while (0)
