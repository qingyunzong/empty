#pragma once

// Minimal test assertions: print the failing expression and abort.

#include <cstdlib>
#include <iostream>

#include "motion/rational.hpp"

#define CHECK(cond)                                                            \
  do {                                                                         \
    if (!(cond)) {                                                             \
      std::cerr << "CHECK failed: " #cond " (" << __FILE__ << ":" << __LINE__ \
                << ")\n";                                                      \
      std::exit(1);                                                            \
    }                                                                          \
  } while (0)

#define CHECK_RAT_EQ(a, b)                                                     \
  do {                                                                         \
    const ::motion::Rational va_ = (a);                                        \
    const ::motion::Rational vb_ = (b);                                        \
    if (va_ != vb_) {                                                          \
      std::cerr << "CHECK failed: " #a " == " #b " (" << va_.to_string()      \
                << " != " << vb_.to_string() << ") (" << __FILE__ << ":"      \
                << __LINE__ << ")\n";                                          \
      std::exit(1);                                                            \
    }                                                                          \
  } while (0)
