#pragma once

#include <cstdio>
#include <cstdlib>
#include <iostream>

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            std::fprintf(stderr, "CHECK failed %s:%d: %s\n", __FILE__,     \
                         __LINE__, #cond);                                 \
            std::abort();                                                  \
        }                                                                  \
    } while (0)

template <typename A, typename B>
void check_eq(const A& a, const B& b, const char* ea, const char* eb,
              int line) {
    if (!(a == b)) {
        std::cerr << "CHECK_EQ failed at line " << line << ": " << ea
                  << " == " << eb << "\n  lhs = ";
        if constexpr (requires { std::cerr << a; })
            std::cerr << a;
        else
            std::cerr << "<unprintable>";
        std::cerr << "\n  rhs = ";
        if constexpr (requires { std::cerr << b; })
            std::cerr << b;
        else
            std::cerr << "<unprintable>";
        std::cerr << "\n";
        std::abort();
    }
}

#define CHECK_EQ(a, ...) check_eq((a), (__VA_ARGS__), #a, #__VA_ARGS__, __LINE__)

// Deterministic PRNG (splitmix64) so every test run is reproducible.
struct rng {
    std::uint64_t s;
    explicit rng(std::uint64_t seed) : s(seed) {}
    std::uint64_t next() {
        s += 0x9e3779b97f4a7c15ull;
        std::uint64_t z = s;
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
        return z ^ (z >> 31);
    }
    std::uint64_t below(std::uint64_t n) { return next() % n; }
};
