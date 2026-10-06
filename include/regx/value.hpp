#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>

namespace regx {

// All expression values are unsigned integers of 8..64 bits.
constexpr unsigned kMinWidth = 8;
constexpr unsigned kMaxWidth = 64;

inline bool validWidth(unsigned w) { return w >= kMinWidth && w <= kMaxWidth; }

inline uint64_t maskFor(unsigned width) {
  return width >= 64 ? ~uint64_t{0} : ((uint64_t{1} << width) - 1);
}

struct Value {
  uint8_t width;
  uint64_t bits; // always kept < 2^width
};

struct Error : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Front-end error (lexing, parsing, static checks). Carries the byte offset
// into the source string where the problem was detected.
struct ParseError : Error {
  size_t pos;
  ParseError(size_t pos, std::string msg) : Error(std::move(msg)), pos(pos) {}
};

// Evaluation-time error (e.g. a register holding a value that does not fit
// its declared width). Only raised for code that is actually executed.
struct RuntimeError : Error {
  using Error::Error;
};

} // namespace regx
