#pragma once

#include <cstdint>

namespace rex {

// Bit mask for a value of the given width (1..64).
inline uint64_t mask_for(uint8_t width) {
  return width >= 64 ? ~uint64_t{0} : ((uint64_t{1} << width) - 1);
}

// An unsigned value tagged with its bit width. `bits` is always kept
// masked to `width` bits.
struct Value {
  uint8_t width = 0;
  uint64_t bits = 0;
};

inline Value make_value(uint8_t width, uint64_t bits) {
  return Value{width, bits & mask_for(width)};
}

inline bool value_eq(Value a, Value b) {
  return a.width == b.width && a.bits == b.bits;
}

} // namespace rex
