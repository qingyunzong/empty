#pragma once

#include "regx/value.hpp"

#include <memory>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace regx {

struct Expr;
using ExprPtr = std::unique_ptr<Expr>;

struct Literal { uint64_t bits; uint8_t width; };
struct RegRef { std::string name; };
struct Slice { ExprPtr base; uint8_t hi, lo; };      // base[hi:lo]
struct Concat { std::vector<ExprPtr> parts; };       // {hi, ..., lo}
struct Add { ExprPtr lhs, rhs; };                    // mod 2^max(width)
struct Shl { ExprPtr value, amount; };               // 0 if amount >= width
struct Shr { ExprPtr value, amount; };               // 0 if amount >= width
struct Eq { ExprPtr lhs, rhs; };                     // 8-bit 0/1
struct Ne { ExprPtr lhs, rhs; };                     // 8-bit 0/1
struct LAnd { ExprPtr lhs, rhs; };                   // short-circuit, 8-bit 0/1
struct LOr { ExprPtr lhs, rhs; };                    // short-circuit, 8-bit 0/1
struct Ternary { ExprPtr cond, ifTrue, ifFalse; };   // short-circuit

using Node = std::variant<Literal, RegRef, Slice, Concat, Add, Shl, Shr,
                          Eq, Ne, LAnd, LOr, Ternary>;

struct Expr {
  Node node;
  uint8_t width; // result width in bits, assigned by the parser
  size_t pos;    // byte offset of the first token of this expression
};

// Register declaration environment, in stable slot order.
struct Schema {
  std::vector<std::pair<std::string, uint8_t>> regs;

  const uint8_t* find(const std::string& name) const {
    for (const auto& [n, w] : regs)
      if (n == name) return &w;
    return nullptr;
  }
  size_t indexOf(const std::string& name) const {
    for (size_t i = 0; i < regs.size(); ++i)
      if (regs[i].first == name) return i;
    throw std::logic_error("unknown register: " + name);
  }
};

template <class... Ts> struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts> overloaded(Ts...) -> overloaded<Ts...>;

} // namespace regx
