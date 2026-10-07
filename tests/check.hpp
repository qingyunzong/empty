#pragma once

#include <cstdlib>
#include <iostream>
#include <string>

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__     \
                      << ": " #cond << std::endl;                              \
            std::exit(1);                                                      \
        }                                                                      \
    } while (0)

namespace testutil {
inline const std::string& to_str(const std::string& s) { return s; }
inline std::string to_str(const char* s) { return s; }
template <typename T>
std::string to_str(const T& v) { return v.to_string(); }
} // namespace testutil

#define CHECK_EQ(a, b)                                                         \
    do {                                                                       \
        auto va_ = (a);                                                        \
        auto vb_ = (b);                                                        \
        if (!(va_ == vb_)) {                                                   \
            std::cerr << "CHECK_EQ failed at " << __FILE__ << ":" << __LINE__  \
                      << "\n  lhs: " << testutil::to_str(va_)                  \
                      << "\n  rhs: " << testutil::to_str(vb_) << std::endl;    \
            std::exit(1);                                                      \
        }                                                                      \
    } while (0)

namespace testutil {

struct SplitMix64 {
    unsigned long long state;
    unsigned long long next() {
        unsigned long long z = (state += 0x9e3779b97f4a7c15ULL);
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
        return z ^ (z >> 31);
    }
    unsigned long long below(unsigned long long n) { return next() % n; }
};

} // namespace testutil
