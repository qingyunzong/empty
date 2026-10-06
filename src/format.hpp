#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace col {

inline constexpr uint8_t kMagic[4] = {'C', 'O', 'L', '1'};
inline constexpr uint8_t kEncRle = 1;
inline constexpr uint8_t kEncBitpack = 2;

struct ColumnError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

inline uint32_t fnv1a(const uint8_t* p, size_t n) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; ++i) {
    h ^= p[i];
    h *= 16777619u;
  }
  return h;
}

}  // namespace col
