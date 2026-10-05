#pragma once

#include <cstdint>
#include <cstdlib>
#include <iostream>

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::cerr << "CHECK failed: " #cond " at " << __FILE__ << ":"         \
                << __LINE__ << std::endl;                                    \
      std::exit(1);                                                          \
    }                                                                        \
  } while (0)

namespace xrtest {

// Deterministic 64-bit PRNG (splitmix64).
struct Rng {
  std::uint64_t state;
  explicit Rng(std::uint64_t seed) : state(seed) {}
  std::uint64_t next() {
    std::uint64_t z = (state += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
  }
  std::uint64_t below(std::uint64_t n) { return next() % n; }
};

} // namespace xrtest
