#pragma once

#include "value.hpp"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace rex {

// A typed expression node. `width` is the result bit width computed
// during parsing; `pos` is the byte offset of the node in the source.
struct Expr {
  enum class Kind {
    Literal, // lit, width
    Reg,     // reg index, width from declaration
    Add,     // kids[0] + kids[1], equal widths, result mod 2^width
    Shl,     // kids[0] << kids[1]; shift >= width yields 0
    Shr,     // kids[0] >> kids[1]; shift >= width yields 0
    Eq,      // kids[0] == kids[1], result width 1
    Ne,      // kids[0] != kids[1], result width 1
    And,     // short-circuit logical and, result width 1
    Or,      // short-circuit logical or, result width 1
    Cond,    // kids[0] ? kids[1] : kids[2], short-circuit
    Slice,   // kids[0][slice_hi:slice_lo]
    Concat,  // {kids[0], kids[1], ...}, kids[0] most significant
  };

  Kind kind;
  uint8_t width = 0;
  size_t pos = 0;

  uint64_t lit = 0;                 // Literal
  uint32_t reg = 0;                 // Reg
  uint8_t slice_hi = 0, slice_lo = 0; // Slice

  std::vector<Expr> kids;
};

// Structural equality, ignoring source positions: grouping and
// whitespace do not change the meaning of an expression.
inline bool ast_equal(const Expr& a, const Expr& b) {
  if (a.kind != b.kind || a.width != b.width || a.lit != b.lit ||
      a.reg != b.reg || a.slice_hi != b.slice_hi ||
      a.slice_lo != b.slice_lo || a.kids.size() != b.kids.size())
    return false;
  for (size_t i = 0; i < a.kids.size(); ++i)
    if (!ast_equal(a.kids[i], b.kids[i]))
      return false;
  return true;
}

} // namespace rex
