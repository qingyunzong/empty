#pragma once

#include "ast.hpp"
#include "regs.hpp"

#include <string>
#include <variant>

namespace rex {

struct RuntimeError {
  std::string msg;
};

// Either a value or a runtime error (e.g. read of an unwritten register).
using EvalResult = std::variant<Value, RuntimeError>;

inline bool is_error(const EvalResult& r) {
  return std::holds_alternative<RuntimeError>(r);
}

// Direct tree-walking evaluation. Conditional operators short-circuit:
// an unexecuted branch is never evaluated, so illegal values in it
// (such as reads of unwritten registers) produce no error.
inline EvalResult eval(const Expr& e, const RegFile& rf) {
  switch (e.kind) {
  case Expr::Kind::Literal:
    return EvalResult{make_value(e.width, e.lit)};
  case Expr::Kind::Reg: {
    const auto& v = rf.values[e.reg];
    if (!v)
      return EvalResult{RuntimeError{"read of unwritten register '" +
                                     rf.names[e.reg] + "'"}};
    return EvalResult{make_value(e.width, *v)};
  }
  case Expr::Kind::Add: {
    auto a = eval(e.kids[0], rf);
    if (is_error(a)) return a;
    auto b = eval(e.kids[1], rf);
    if (is_error(b)) return b;
    // Addition is modulo the result width; for width 64 the uint64
    // wraparound is exactly the required modulus.
    return EvalResult{make_value(
        e.width, std::get<Value>(a).bits + std::get<Value>(b).bits)};
  }
  case Expr::Kind::Shl:
  case Expr::Kind::Shr: {
    auto v = eval(e.kids[0], rf);
    if (is_error(v)) return v;
    auto amt = eval(e.kids[1], rf);
    if (is_error(amt)) return amt;
    const uint64_t n = std::get<Value>(amt).bits;
    const uint64_t x = std::get<Value>(v).bits;
    uint64_t r;
    if (n >= e.width)
      r = 0; // shift amount at or beyond the width yields zero
    else if (e.kind == Expr::Kind::Shl)
      r = x << n;
    else
      r = x >> n;
    return EvalResult{make_value(e.width, r)};
  }
  case Expr::Kind::Eq:
  case Expr::Kind::Ne: {
    auto a = eval(e.kids[0], rf);
    if (is_error(a)) return a;
    auto b = eval(e.kids[1], rf);
    if (is_error(b)) return b;
    const bool eq = std::get<Value>(a).bits == std::get<Value>(b).bits;
    return EvalResult{
        make_value(1, (e.kind == Expr::Kind::Eq) == eq ? 1 : 0)};
  }
  case Expr::Kind::And: {
    auto a = eval(e.kids[0], rf);
    if (is_error(a)) return a;
    if (std::get<Value>(a).bits == 0)
      return EvalResult{make_value(1, 0)}; // short-circuit
    auto b = eval(e.kids[1], rf);
    if (is_error(b)) return b;
    return EvalResult{make_value(1, std::get<Value>(b).bits != 0 ? 1 : 0)};
  }
  case Expr::Kind::Or: {
    auto a = eval(e.kids[0], rf);
    if (is_error(a)) return a;
    if (std::get<Value>(a).bits != 0)
      return EvalResult{make_value(1, 1)}; // short-circuit
    auto b = eval(e.kids[1], rf);
    if (is_error(b)) return b;
    return EvalResult{make_value(1, std::get<Value>(b).bits != 0 ? 1 : 0)};
  }
  case Expr::Kind::Cond: {
    auto c = eval(e.kids[0], rf);
    if (is_error(c)) return c;
    // Only the taken branch is evaluated.
    return eval(e.kids[std::get<Value>(c).bits != 0 ? 1 : 2], rf);
  }
  case Expr::Kind::Slice: {
    auto v = eval(e.kids[0], rf);
    if (is_error(v)) return v;
    return EvalResult{
        make_value(e.width, std::get<Value>(v).bits >> e.slice_lo)};
  }
  case Expr::Kind::Concat: {
    uint64_t acc = 0;
    uint32_t acc_width = 0;
    for (const auto& k : e.kids) {
      auto v = eval(k, rf);
      if (is_error(v)) return v;
      const Value val = std::get<Value>(v);
      if (acc_width == 0)
        acc = val.bits; // avoids a 64-bit shift of the accumulator
      else
        acc = (acc << val.width) | val.bits;
      acc_width += val.width;
    }
    return EvalResult{make_value(e.width, acc)};
  }
  }
  return EvalResult{RuntimeError{"unknown expression kind"}};
}

} // namespace rex
