#pragma once

#include <charconv>
#include <cmath>
#include <cstdint>
#include <limits>
#include <ostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

#include "dlks/value.hpp"

namespace dlks {

enum class Op : std::uint8_t {
  Add,
  Sub,
  Mul,
  Div,
  Mod,
  Neg,
  Not,
  And,
  Or,
  Eq,
  Ne,
  Lt,
  Le,
  Gt,
  Ge
};

constexpr std::string_view op_symbol(Op op) noexcept {
  switch (op) {
    case Op::Add: return "+";
    case Op::Sub: return "-";
    case Op::Mul: return "*";
    case Op::Div: return "/";
    case Op::Mod: return "%";
    case Op::Neg: return "-";
    case Op::Not: return "not";
    case Op::And: return "and";
    case Op::Or: return "or";
    case Op::Eq: return "==";
    case Op::Ne: return "!=";
    case Op::Lt: return "<";
    case Op::Le: return "<=";
    case Op::Gt: return ">";
    case Op::Ge: return ">=";
  }
  return "?";
}

constexpr std::string_view op_name(Op op) noexcept {
  switch (op) {
    case Op::Add: return "add";
    case Op::Sub: return "sub";
    case Op::Mul: return "mul";
    case Op::Div: return "div";
    case Op::Mod: return "mod";
    case Op::Neg: return "neg";
    case Op::Not: return "not";
    case Op::And: return "and";
    case Op::Or: return "or";
    case Op::Eq: return "eq";
    case Op::Ne: return "ne";
    case Op::Lt: return "lt";
    case Op::Le: return "le";
    case Op::Gt: return "gt";
    case Op::Ge: return "ge";
  }
  return "?";
}

constexpr bool is_comparison(Op op) noexcept {
  return op == Op::Eq || op == Op::Ne || op == Op::Lt || op == Op::Le || op == Op::Gt ||
         op == Op::Ge;
}

inline std::ostream& operator<<(std::ostream& os, Op op) { return os << op_symbol(op); }

inline bool is_numeric(Type type) noexcept {
  return type == Type::Int64 || type == Type::Double;
}

// A row-local evaluation failure raised by a scalar kernel. The engines turn
// it into an ErrorInfo tagged with the current row and expression node.
class KernelError : public std::runtime_error {
 public:
  explicit KernelError(const std::string& message) : std::runtime_error(message) {}
};

[[noreturn]] inline void kernel_fail(const std::string& message) {
  throw KernelError(message);
}

inline bool is_castable(Type from, Type to) noexcept {
  if (from == Type::Null) {
    return to != Type::Null;
  }
  if (to == Type::Null) {
    return false;
  }
  if (from == to) {
    return true;
  }
  switch (from) {
    case Type::Bool:
      return to == Type::Int64 || to == Type::Double || to == Type::String;
    case Type::Int64:
      return to == Type::Bool || to == Type::Double || to == Type::String;
    case Type::Double:
      return to == Type::Bool || to == Type::Int64 || to == Type::String;
    case Type::String:
      return to == Type::Bool || to == Type::Int64 || to == Type::Double;
    case Type::Null:
      return false;
  }
  return false;
}

namespace kernel_detail {

inline std::string overflow_message(Op op) {
  return "integer overflow in '" + std::string(op_symbol(op)) + "'";
}

inline std::int64_t add_checked(std::int64_t lhs, std::int64_t rhs, Op op) {
  constexpr std::int64_t kMin = std::numeric_limits<std::int64_t>::min();
  constexpr std::int64_t kMax = std::numeric_limits<std::int64_t>::max();
  if ((rhs > 0 && lhs > kMax - rhs) || (rhs < 0 && lhs < kMin - rhs)) {
    kernel_fail(overflow_message(op));
  }
  return lhs + rhs;
}

inline std::int64_t sub_checked(std::int64_t lhs, std::int64_t rhs, Op op) {
  constexpr std::int64_t kMin = std::numeric_limits<std::int64_t>::min();
  constexpr std::int64_t kMax = std::numeric_limits<std::int64_t>::max();
  if ((rhs > 0 && lhs < kMin + rhs) || (rhs < 0 && lhs > kMax + rhs)) {
    kernel_fail(overflow_message(op));
  }
  return lhs - rhs;
}

inline std::int64_t mul_checked(std::int64_t lhs, std::int64_t rhs, Op op) {
  constexpr std::int64_t kMin = std::numeric_limits<std::int64_t>::min();
  constexpr std::int64_t kMax = std::numeric_limits<std::int64_t>::max();
  if (lhs == 0 || rhs == 0) {
    return 0;
  }
  if (rhs == -1) {
    if (lhs == kMin) {
      kernel_fail(overflow_message(op));
    }
    return -lhs;
  }
  if (lhs > 0) {
    if (rhs > 0) {
      if (lhs > kMax / rhs) {
        kernel_fail(overflow_message(op));
      }
    } else if (rhs < kMin / lhs) {
      kernel_fail(overflow_message(op));
    }
  } else {
    if (rhs > 0) {
      if (lhs < kMin / rhs) {
        kernel_fail(overflow_message(op));
      }
    } else if (lhs < kMax / rhs) {
      kernel_fail(overflow_message(op));
    }
  }
  return lhs * rhs;
}

inline double as_double(const Value& value) {
  return value.type() == Type::Int64 ? static_cast<double>(value.as_i64()) : value.as_f64();
}

// Exact ordering of an int64 against a finite double. Converting both to
// double is lossy for large integers, so compare the integral part first and
// then the fractional part.
inline int compare_int_double(std::int64_t integer, double real) {
  constexpr double kMin = -9223372036854775808.0;
  constexpr double kMaxExclusive = 9223372036854775808.0;
  if (std::isnan(real)) {
    kernel_fail("cannot compare NaN");
  }
  if (real < kMin) {
    return 1;
  }
  if (real >= kMaxExclusive) {
    return -1;
  }
  const double truncated = std::trunc(real);
  const std::int64_t integral = static_cast<std::int64_t>(truncated);
  if (integer < integral) {
    return -1;
  }
  if (integer > integral) {
    return 1;
  }
  if (real > truncated) {
    return -1;
  }
  if (real < truncated) {
    return 1;
  }
  return 0;
}

inline std::string type_pair(Type lhs, Type rhs) {
  return std::string(type_name(lhs)) + " and " + std::string(type_name(rhs));
}

}  // namespace kernel_detail

inline Value apply_binary(Op op, const Value& lhs, const Value& rhs) {
  if (op == Op::And || op == Op::Or) {
    kernel_fail("internal error: boolean operator reached value kernel");
  }
  // SQL three-valued logic: any NULL operand makes arithmetic and comparison
  // results NULL. Boolean operators are evaluated by the engines because they
  // short-circuit.
  if (lhs.is_null() || rhs.is_null()) {
    return Value{};
  }

  const Type lhs_type = lhs.type();
  const Type rhs_type = rhs.type();

  if (is_comparison(op)) {
    int order = 0;
    if (lhs_type == Type::Int64 && rhs_type == Type::Int64) {
      const std::int64_t a = lhs.as_i64();
      const std::int64_t b = rhs.as_i64();
      order = a < b ? -1 : (a > b ? 1 : 0);
    } else if (lhs_type == Type::Double && rhs_type == Type::Double) {
      const double a = lhs.as_f64();
      const double b = rhs.as_f64();
      if (std::isnan(a) || std::isnan(b)) {
        kernel_fail("cannot compare NaN");
      }
      order = a < b ? -1 : (a > b ? 1 : 0);
    } else if (lhs_type == Type::Int64 && rhs_type == Type::Double) {
      order = kernel_detail::compare_int_double(lhs.as_i64(), rhs.as_f64());
    } else if (lhs_type == Type::Double && rhs_type == Type::Int64) {
      order = -kernel_detail::compare_int_double(rhs.as_i64(), lhs.as_f64());
    } else if (lhs_type == rhs_type) {
      switch (lhs_type) {
        case Type::Bool: {
          const bool a = lhs.as_bool();
          const bool b = rhs.as_bool();
          order = a == b ? 0 : (a ? 1 : -1);
          break;
        }
        case Type::Int64:
        case Type::Double:
          break;
        case Type::String: {
          const int compared = lhs.as_string().compare(rhs.as_string());
          order = compared < 0 ? -1 : (compared > 0 ? 1 : 0);
          break;
        }
        case Type::Null:
          return Value{};
      }
    } else {
      kernel_fail("cannot compare " + kernel_detail::type_pair(lhs_type, rhs_type));
    }
    switch (op) {
      case Op::Eq: return Value(order == 0);
      case Op::Ne: return Value(order != 0);
      case Op::Lt: return Value(order < 0);
      case Op::Le: return Value(order <= 0);
      case Op::Gt: return Value(order > 0);
      case Op::Ge: return Value(order >= 0);
      default: break;
    }
    kernel_fail("internal error: unknown comparison");
  }

  const bool mod = op == Op::Mod;
  if (!is_numeric(lhs_type) || !is_numeric(rhs_type)) {
    kernel_fail("operator '" + std::string(op_symbol(op)) + "' requires numeric operands, got " +
                kernel_detail::type_pair(lhs_type, rhs_type));
  }
  if (mod && (lhs_type != Type::Int64 || rhs_type != Type::Int64)) {
    kernel_fail("operator '%' requires int64 operands");
  }

  if (lhs_type == Type::Int64 && rhs_type == Type::Int64) {
    const std::int64_t a = lhs.as_i64();
    const std::int64_t b = rhs.as_i64();
    switch (op) {
      case Op::Add: return Value(kernel_detail::add_checked(a, b, op));
      case Op::Sub: return Value(kernel_detail::sub_checked(a, b, op));
      case Op::Mul: return Value(kernel_detail::mul_checked(a, b, op));
      case Op::Div:
        if (b == 0) {
          kernel_fail("division by zero");
        }
        if (a == std::numeric_limits<std::int64_t>::min() && b == -1) {
          kernel_fail(kernel_detail::overflow_message(op));
        }
        return Value(a / b);
      case Op::Mod:
        if (b == 0) {
          kernel_fail("modulo by zero");
        }
        if (a == std::numeric_limits<std::int64_t>::min() && b == -1) {
          return Value(std::int64_t{0});
        }
        return Value(a % b);
      default:
        break;
    }
    kernel_fail("internal error: unknown integer operator");
  }

  const double a = kernel_detail::as_double(lhs);
  const double b = kernel_detail::as_double(rhs);
  double result = 0.0;
  switch (op) {
    case Op::Add: result = a + b; break;
    case Op::Sub: result = a - b; break;
    case Op::Mul: result = a * b; break;
    case Op::Div:
      if (b == 0.0) {
        kernel_fail("division by zero");
      }
      result = a / b;
      break;
    default:
      kernel_fail("internal error: unknown floating point operator");
  }
  if (!std::isfinite(result)) {
    kernel_fail("non-finite result in '" + std::string(op_symbol(op)) + "'");
  }
  return Value(result);
}

inline Value apply_unary(Op op, const Value& value) {
  if (value.is_null()) {
    return Value{};
  }
  if (op == Op::Not) {
    if (value.type() != Type::Bool) {
      kernel_fail("operator 'not' requires a boolean operand, got " +
                  std::string(type_name(value.type())));
    }
    return Value(!value.as_bool());
  }
  if (op != Op::Neg) {
    kernel_fail("internal error: unsupported unary operator");
  }
  if (value.type() == Type::Int64) {
    if (value.as_i64() == std::numeric_limits<std::int64_t>::min()) {
      kernel_fail(kernel_detail::overflow_message(op));
    }
    return Value(-value.as_i64());
  }
  if (value.type() == Type::Double) {
    return Value(-value.as_f64());
  }
  kernel_fail("unary '-' requires a numeric operand, got " +
              std::string(type_name(value.type())));
}

inline Value apply_cast(const Value& value, Type target) {
  if (value.is_null()) {
    return Value{};
  }
  if (target == Type::Null) {
    kernel_fail("cannot cast to null type");
  }
  if (value.type() == target) {
    return value;
  }

  switch (target) {
    case Type::String: {
      switch (value.type()) {
        case Type::Bool:
          return Value(value.as_bool() ? "true" : "false");
        case Type::Int64:
          return Value(std::to_string(value.as_i64()));
        case Type::Double: {
          char buffer[64];
          const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value.as_f64(),
                                            std::chars_format::general);
          if (result.ec != std::errc{}) {
            kernel_fail("failed to format double as string");
          }
          return Value(std::string(buffer, result.ptr));
        }
        default:
          break;
      }
      break;
    }
    case Type::Bool: {
      switch (value.type()) {
        case Type::Int64:
          return Value(value.as_i64() != 0);
        case Type::Double:
          return Value(value.as_f64() != 0.0);
        case Type::String: {
          const std::string& text = value.as_string();
          if (text == "true") {
            return Value(true);
          }
          if (text == "false") {
            return Value(false);
          }
          kernel_fail("invalid bool literal '" + text + "'");
        }
        default:
          break;
      }
      break;
    }
    case Type::Int64: {
      switch (value.type()) {
        case Type::Bool:
          return Value(value.as_bool() ? std::int64_t{1} : std::int64_t{0});
        case Type::Double: {
          const double number = value.as_f64();
          constexpr double kMin = -9223372036854775808.0;
          constexpr double kMaxExclusive = 9223372036854775808.0;
          if (!std::isfinite(number) || number < kMin || number >= kMaxExclusive) {
            kernel_fail("double value out of int64 range");
          }
          return Value(static_cast<std::int64_t>(number));
        }
        case Type::String: {
          const std::string& text = value.as_string();
          std::int64_t parsed = 0;
          const auto result =
              std::from_chars(text.data(), text.data() + text.size(), parsed);
          if (result.ec != std::errc{} || result.ptr != text.data() + text.size()) {
            kernel_fail("invalid int64 literal '" + text + "'");
          }
          return Value(parsed);
        }
        default:
          break;
      }
      break;
    }
    case Type::Double: {
      switch (value.type()) {
        case Type::Bool:
          return Value(value.as_bool() ? 1.0 : 0.0);
        case Type::Int64:
          return Value(static_cast<double>(value.as_i64()));
        case Type::String: {
          const std::string& text = value.as_string();
          double parsed = 0.0;
          const auto result =
              std::from_chars(text.data(), text.data() + text.size(), parsed);
          if (result.ec != std::errc{} || result.ptr != text.data() + text.size() ||
              !std::isfinite(parsed)) {
            kernel_fail("invalid double literal '" + text + "'");
          }
          return Value(parsed);
        }
        default:
          break;
      }
      break;
    }
    case Type::Null:
      break;
  }
  kernel_fail("cannot cast " + std::string(type_name(value.type())) + " to " +
              std::string(type_name(target)));
}

}  // namespace dlks
