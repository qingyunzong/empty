#pragma once

#include <cstdlib>
#include <iostream>

// Minimal test assertions: print and abort on failure.
#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::cerr << __FILE__ << ":" << __LINE__ << " CHECK failed: " #cond  \
                      << std::endl;                                              \
            std::exit(1);                                                        \
        }                                                                        \
    } while (0)

#define CHECK_EQ(a, b)                                                           \
    do {                                                                         \
        auto va_ = (a);                                                          \
        auto vb_ = (b);                                                          \
        if (!(va_ == vb_)) {                                                     \
            std::cerr << __FILE__ << ":" << __LINE__ << " CHECK_EQ failed: " #a  \
                      " == " #b " (" << va_ << " vs " << vb_ << ")" << std::endl;\
            std::exit(1);                                                        \
        }                                                                        \
    } while (0)
