#pragma once

#include <cstdio>
#include <cstdlib>

#include "cosched/cosched.hpp"

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "CHECK failed: %s (%s:%d)\n", #cond,        \
                         __FILE__, __LINE__);                                \
            std::exit(1);                                                    \
        }                                                                    \
    } while (0)

inline void print_history(const cosched::scheduler& s, const char* title) {
    std::printf("[%s] per-frame stats\n", title);
    std::printf("  frame | posted | resumed | freed | timers_fired\n");
    for (const auto& f : s.history())
        std::printf("  %5llu | %6zu | %7zu | %5zu | %12zu\n",
                    static_cast<unsigned long long>(f.frame), f.posted,
                    f.resumed, f.freed, f.timers_fired);
    std::printf("  totals: resumed=%zu freed=%zu pending_ops=%zu\n",
                s.total_resumed(), s.total_freed(), s.pending_operations());
}
