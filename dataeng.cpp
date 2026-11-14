#include "dataeng.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <set>
#include <unordered_set>
#include <utility>

namespace dataeng {
namespace {

std::uint32_t load_le32(std::string_view value) {
  return static_cast<std::uint32_t>(static_cast<unsigned char>(value[0])) |
         (static_cast<std::uint32_t>(static_cast<unsigned char>(value[1]))
          << 8) |
         (static_cast<std::uint32_t>(static_cast<unsigned char>(value[2]))
          << 16) |
         (static_cast<std::uint32_t>(static_cast<unsigned char>(value[3]))
          << 24);
}

std::uint64_t load_le64(std::string_view value) {
  std::uint64_t result = 0;
  for (int i = 7; i >= 0; --i) {
    result = (result << 8) |
             static_cast<unsigned char>(value[static_cast<std::size_t>(i)]);
  }
  return result;
}

std::string store_le32(std::uint32_t value) {
  std::string out(4, '\0');
  for (int i = 0; i < 4; ++i) {
    out[static_cast<std::size_t>(i)] =
        static_cast<char>((value >> (8 * i)) & 0xFFu);
  }
  return out;
}

std::string store_le64(std::uint64_t value) {
  std::string out(8, '\0');
  for (int i = 0; i < 8; ++i) {
    out[static_cast<std::size_t>(i)] =
        static_cast<char>((value >> (8 * i)) & 0xFFu);
  }
  return out;
}

float load_float(std::string_view value) {
  const std::uint32_t bits = load_le32(value);
  float result = 0.0F;
  std::memcpy(&result, &bits, sizeof(result));
  return result;
}

double load_double(std::string_view value) {
  const std::uint64_t bits = load_le64(value);
  double result = 0.0;
  std::memcpy(&result, &bits, sizeof(result));
  return result;
}

std::string store_float(float value) {
  std::uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  return store_le32(bits);
}

std::string store_double(double value) {
  std::uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  return store_le64(bits);
}

bool is_binary(PhysicalType type) {
  return type == PhysicalType::ByteArray ||
         type == PhysicalType::FixedLenByteArray;
}

bool is_floating(PhysicalType type) {
  return type == PhysicalType::Float || type == PhysicalType::Double;
}

bool is_decimal(const ColumnDescriptor& descriptor) {
  return descriptor.logical_type == LogicalType::Decimal;
}

int compare_unsigned(std::string_view left, std::string_view right) {
  const std::size_t common = std::min(left.size(), right.size());
  for (std::size_t i = 0; i < common; ++i) {
    const auto a = static_cast<unsigned char>(left[i]);
    const auto b = static_cast<unsigned char>(right[i]);
    if (a != b) {
      return a < b ? -1 : 1;
    }
  }
  if (left.size() == right.size()) {
    return 0;
  }
  return left.size() < right.size() ? -1 : 1;
}

// Compares big-endian two's-complement byte strings.  The operands may have
// different widths; the shorter one is sign-extended before comparison.
int compare_signed_big_endian(std::string_view left, std::string_view right) {
  const bool left_negative =
      !left.empty() && (static_cast<unsigned char>(left.front()) & 0x80u) != 0;
  const bool right_negative =
      !right.empty() && (static_cast<unsigned char>(right.front()) & 0x80u) != 0;

  if (left_negative != right_negative) {
    return left_negative ? -1 : 1;
  }

  const unsigned char extension = left_negative ? 0xFFu : 0x00u;
  const std::size_t width = std::max(left.size(), right.size());
  const std::size_t left_pad = width - left.size();
  const std::size_t right_pad = width - right.size();

  for (std::size_t i = 0; i < width; ++i) {
    const unsigned char a =
        i < left_pad ? extension
                     : static_cast<unsigned char>(left[i - left_pad]);
    const unsigned char b =
        i < right_pad ? extension
                      : static_cast<unsigned char>(right[i - right_pad]);
    if (a != b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

std::optional<int> compare_encoded(const ColumnDescriptor& descriptor,
                                   std::string_view left,
                                   std::string_view right) {
  switch (descriptor.physical_type) {
    case PhysicalType::Boolean: {
      if (left.empty() || right.empty()) {
        return std::nullopt;
      }
      const bool a = left[0] != 0;
      const bool b = right[0] != 0;
      if (a == b) {
        return 0;
      }
      return a ? 1 : -1;
    }
    case PhysicalType::Int32: {
      if (left.size() < 4 || right.size() < 4) {
        return std::nullopt;
      }
      if (descriptor.sort_order == SortOrder::Unsigned) {
        const std::uint32_t a = load_le32(left);
        const std::uint32_t b = load_le32(right);
        return a == b ? 0 : (a < b ? -1 : 1);
      }
      if (descriptor.sort_order == SortOrder::Signed ||
          descriptor.sort_order == SortOrder::Unknown) {
        const auto a = static_cast<std::int32_t>(load_le32(left));
        const auto b = static_cast<std::int32_t>(load_le32(right));
        return a == b ? 0 : (a < b ? -1 : 1);
      }
      return std::nullopt;
    }
    case PhysicalType::Int64: {
      if (left.size() < 8 || right.size() < 8) {
        return std::nullopt;
      }
      if (descriptor.sort_order == SortOrder::Unsigned) {
        const std::uint64_t a = load_le64(left);
        const std::uint64_t b = load_le64(right);
        return a == b ? 0 : (a < b ? -1 : 1);
      }
      if (descriptor.sort_order == SortOrder::Signed ||
          descriptor.sort_order == SortOrder::Unknown) {
        const auto a = static_cast<std::int64_t>(load_le64(left));
        const auto b = static_cast<std::int64_t>(load_le64(right));
        return a == b ? 0 : (a < b ? -1 : 1);
      }
      return std::nullopt;
    }
    case PhysicalType::Float: {
      if (left.size() < 4 || right.size() < 4) {
        return std::nullopt;
      }
      const float a = load_float(left);
      const float b = load_float(right);
      if (std::isnan(a) || std::isnan(b)) {
        return std::nullopt;
      }
      return a == b ? 0 : (a < b ? -1 : 1);
    }
    case PhysicalType::Double: {
      if (left.size() < 8 || right.size() < 8) {
        return std::nullopt;
      }
      const double a = load_double(left);
      const double b = load_double(right);
      if (std::isnan(a) || std::isnan(b)) {
        return std::nullopt;
      }
      return a == b ? 0 : (a < b ? -1 : 1);
    }
    case PhysicalType::ByteArray:
    case PhysicalType::FixedLenByteArray: {
      if (descriptor.sort_order == SortOrder::Signed ||
          (descriptor.sort_order == SortOrder::Unknown &&
           is_decimal(descriptor))) {
        return compare_signed_big_endian(left, right);
      }
      return compare_unsigned(left, right);
    }
    case PhysicalType::Int96:
      // The old INT96 ordering is not defined by Parquet.  Unless a caller
      // supplies a custom comparator, never use INT96 statistics.
      return std::nullopt;
  }
  return std::nullopt;
}

bool encoded_is_nan(const ColumnDescriptor& descriptor,
                    std::string_view value) {
  if (descriptor.physical_type == PhysicalType::Float && value.size() >= 4) {
    return std::isnan(load_float(value));
  }
  if (descriptor.physical_type == PhysicalType::Double && value.size() >= 8) {
    return std::isnan(load_double(value));
  }
  return false;
}

// The smallest byte string that is greater than every string having `prefix`.
// For example, successor("ab") == "ac" and successor("ab\xff") == "ac".
// Returns nullopt when every string is a prefix extension (empty or all 0xff).
std::optional<std::string> prefix_successor(std::string_view prefix) {
  std::string result(prefix);
  while (!result.empty()) {
    const auto last = static_cast<unsigned char>(result.back());
    if (last != 0xFFu) {
      result.back() = static_cast<char>(last + 1);
      return result;
    }
    result.pop_back();
  }
  return std::nullopt;
}

struct PreparedLiteral {
  enum class Kind { Encoded, AboveAll, BelowAll, Nan, Invalid };
  Kind kind = Kind::Invalid;
  std::string bytes;
};

PreparedLiteral prepare_literal(const ColumnDescriptor& descriptor,
                                const Literal& literal) {
  PreparedLiteral result;

  if (is_floating(descriptor.physical_type) && literal.is_nan()) {
    result.kind = PreparedLiteral::Kind::Nan;
    return result;
  }

  if (is_binary(descriptor.physical_type)) {
    if (literal.kind == LiteralKind::Binary) {
      result.kind = PreparedLiteral::Kind::Encoded;
      result.bytes = literal.bytes;
    }
    return result;
  }

  if (descriptor.physical_type == PhysicalType::Boolean) {
    bool value = false;
    switch (literal.kind) {
      case LiteralKind::Boolean:
        value = literal.bool_value;
        break;
      case LiteralKind::Int32:
      case LiteralKind::Int64:
        if (literal.signed_value == 0 || literal.signed_value == 1) {
          value = literal.signed_value == 1;
        } else {
          return result;
        }
        break;
      case LiteralKind::UInt32:
      case LiteralKind::UInt64:
        if (literal.unsigned_value == 0 || literal.unsigned_value == 1) {
          value = literal.unsigned_value == 1;
        } else {
          return result;
        }
        break;
      default:
        return result;
    }
    result.kind = PreparedLiteral::Kind::Encoded;
    result.bytes.assign(1, value ? '\1' : '\0');
    return result;
  }

  if (descriptor.physical_type == PhysicalType::Int32) {
    if (descriptor.sort_order == SortOrder::Signed ||
        descriptor.sort_order == SortOrder::Unknown) {
      switch (literal.kind) {
        case LiteralKind::Int32:
        case LiteralKind::Int64: {
          const std::int64_t value = literal.signed_value;
          if (value < std::numeric_limits<std::int32_t>::min()) {
            result.kind = PreparedLiteral::Kind::BelowAll;
          } else if (value > std::numeric_limits<std::int32_t>::max()) {
            result.kind = PreparedLiteral::Kind::AboveAll;
          } else {
            result.kind = PreparedLiteral::Kind::Encoded;
            result.bytes =
                store_le32(static_cast<std::uint32_t>(value));
          }
          return result;
        }
        case LiteralKind::UInt32:
        case LiteralKind::UInt64: {
          const std::uint64_t value = literal.unsigned_value;
          if (value >
              static_cast<std::uint64_t>(
                  std::numeric_limits<std::int32_t>::max())) {
            // The caller may have meant the bit pattern rather than an
            // unsigned magnitude.  Stay conservative instead of pruning.
            return result;
          } else {
            result.kind = PreparedLiteral::Kind::Encoded;
            result.bytes =
                store_le32(static_cast<std::uint32_t>(value));
          }
          return result;
        }
        default:
          return result;
      }
    }

    // UINT32
    switch (literal.kind) {
      case LiteralKind::UInt32:
      case LiteralKind::UInt64: {
        const std::uint64_t value = literal.unsigned_value;
        if (value > std::numeric_limits<std::uint32_t>::max()) {
          result.kind = PreparedLiteral::Kind::AboveAll;
        } else {
          result.kind = PreparedLiteral::Kind::Encoded;
          result.bytes = store_le32(static_cast<std::uint32_t>(value));
        }
        return result;
      }
      case LiteralKind::Int32:
      case LiteralKind::Int64: {
        const std::int64_t value = literal.signed_value;
        if (value < 0) {
          // Ambiguous between a signed value and an unsigned bit pattern.
          return result;
        } else if (static_cast<std::uint64_t>(value) >
                   std::numeric_limits<std::uint32_t>::max()) {
          result.kind = PreparedLiteral::Kind::AboveAll;
        } else {
          result.kind = PreparedLiteral::Kind::Encoded;
          result.bytes =
              store_le32(static_cast<std::uint32_t>(value));
        }
        return result;
      }
      default:
        return result;
    }
  }

  if (descriptor.physical_type == PhysicalType::Int64) {
    if (descriptor.sort_order == SortOrder::Signed ||
        descriptor.sort_order == SortOrder::Unknown) {
      switch (literal.kind) {
        case LiteralKind::Int32:
        case LiteralKind::Int64: {
          result.kind = PreparedLiteral::Kind::Encoded;
          result.bytes =
              store_le64(static_cast<std::uint64_t>(literal.signed_value));
          return result;
        }
        case LiteralKind::UInt32: {
          result.kind = PreparedLiteral::Kind::Encoded;
          result.bytes = store_le64(literal.unsigned_value);
          return result;
        }
        case LiteralKind::UInt64: {
          if (literal.unsigned_value >
              static_cast<std::uint64_t>(
                  std::numeric_limits<std::int64_t>::max())) {
            return result;
          } else {
            result.kind = PreparedLiteral::Kind::Encoded;
            result.bytes = store_le64(literal.unsigned_value);
          }
          return result;
        }
        default:
          return result;
      }
    }

    // UINT64
    switch (literal.kind) {
      case LiteralKind::UInt32:
      case LiteralKind::UInt64:
        result.kind = PreparedLiteral::Kind::Encoded;
        result.bytes = store_le64(literal.unsigned_value);
        return result;
      case LiteralKind::Int32:
      case LiteralKind::Int64:
        if (literal.signed_value < 0) {
          return result;
        } else {
          result.kind = PreparedLiteral::Kind::Encoded;
          result.bytes =
              store_le64(static_cast<std::uint64_t>(literal.signed_value));
        }
        return result;
      default:
        return result;
    }
  }

  if (descriptor.physical_type == PhysicalType::Float ||
      descriptor.physical_type == PhysicalType::Double) {
    long double value = 0.0L;
    switch (literal.kind) {
      case LiteralKind::Float:
      case LiteralKind::Double:
        value = static_cast<long double>(literal.double_value);
        break;
      case LiteralKind::Int32:
      case LiteralKind::Int64:
        value = static_cast<long double>(literal.signed_value);
        break;
      case LiteralKind::UInt32:
      case LiteralKind::UInt64:
        value = static_cast<long double>(literal.unsigned_value);
        break;
      default:
        return result;
    }

    if (std::isnan(value)) {
      result.kind = PreparedLiteral::Kind::Nan;
      return result;
    }

    if (descriptor.physical_type == PhysicalType::Float) {
      const long double max_float =
          static_cast<long double>(std::numeric_limits<float>::max());
      if (!std::isinf(value) && value > max_float) {
        result.kind = PreparedLiteral::Kind::AboveAll;
        return result;
      }
      if (!std::isinf(value) && value < -max_float) {
        result.kind = PreparedLiteral::Kind::BelowAll;
        return result;
      }
      const float converted = static_cast<float>(value);
      if (static_cast<long double>(converted) != value) {
        // The literal is not representable in the physical domain.  Refuse to
        // prune rather than risk rounding a bound in the wrong direction.
        return result;
      }
      result.kind = PreparedLiteral::Kind::Encoded;
      result.bytes = store_float(converted);
      return result;
    }

    const long double max_double =
        static_cast<long double>(std::numeric_limits<double>::max());
    if (!std::isinf(value) && value > max_double) {
      result.kind = PreparedLiteral::Kind::AboveAll;
      return result;
    }
    if (!std::isinf(value) && value < -max_double) {
      result.kind = PreparedLiteral::Kind::BelowAll;
      return result;
    }
    const double converted = static_cast<double>(value);
    if (static_cast<long double>(converted) != value) {
      return result;
    }
    result.kind = PreparedLiteral::Kind::Encoded;
    result.bytes = store_double(converted);
    return result;
  }

  return result;
}

CompareOp negate(CompareOp op) {
  switch (op) {
    case CompareOp::Equal:
      return CompareOp::NotEqual;
    case CompareOp::NotEqual:
      return CompareOp::Equal;
    case CompareOp::Less:
      return CompareOp::GreaterEqual;
    case CompareOp::LessEqual:
      return CompareOp::Greater;
    case CompareOp::Greater:
      return CompareOp::LessEqual;
    case CompareOp::GreaterEqual:
      return CompareOp::Less;
  }
  return CompareOp::NotEqual;
}

struct PageBounds {
  bool usable = false;
  bool has_lower = false;
  std::string lower;  // inclusive
  bool has_upper = false;
  std::string upper;
  bool upper_inclusive = true;
  bool singleton = false;
};

PageBounds build_bounds(const ColumnDescriptor& descriptor,
                        const PageStatistics& stats) {
  PageBounds bounds;
  if (stats.all_null || (!stats.has_min && !stats.has_max)) {
    return bounds;
  }
  if (stats.min_nan || stats.max_nan) {
    return bounds;
  }
  if (descriptor.sort_order == SortOrder::Unknown ||
      descriptor.physical_type == PhysicalType::Int96) {
    return bounds;
  }
  if (stats.has_min && !stats.min_exact &&
      !is_binary(descriptor.physical_type)) {
    // For fixed-width types, an explicitly inexact min is not a usable lower
    // bound.  (Byte-array min truncation still yields a prefix lower bound.)
    return bounds;
  }
  if (is_binary(descriptor.physical_type) &&
      (is_decimal(descriptor) ||
       descriptor.sort_order == SortOrder::Signed) &&
      ((stats.has_min && !stats.min_exact) ||
       (stats.has_max && !stats.max_exact))) {
    // Prefix truncation is defined for byte-wise unsigned ordering.  A
    // truncated signed big-endian value is not a safe bound in that domain.
    return bounds;
  }

  if (stats.has_min && stats.has_max) {
    const auto order = compare_encoded(descriptor, stats.min_value,
                                       stats.max_value);
    if (!order || *order > 0) {
      return bounds;
    }
  }

  if (stats.has_min) {
    if (!compare_encoded(descriptor, stats.min_value, stats.min_value)) {
      return bounds;
    }
    bounds.has_lower = true;
    bounds.lower = stats.min_value;
  }

  if (stats.has_max) {
    if (stats.max_exact) {
      bounds.has_upper = true;
      bounds.upper = stats.max_value;
      bounds.upper_inclusive = true;
    } else if (is_binary(descriptor.physical_type)) {
      const bool full_width =
          descriptor.physical_type == PhysicalType::FixedLenByteArray &&
          descriptor.type_length > 0 &&
          static_cast<std::int32_t>(stats.max_value.size()) >=
              descriptor.type_length;
      if (full_width) {
        bounds.has_upper = true;
        bounds.upper = stats.max_value;
        bounds.upper_inclusive = true;
      } else {
        const auto successor = prefix_successor(stats.max_value);
        if (successor) {
          bounds.has_upper = true;
          bounds.upper = *successor;
          bounds.upper_inclusive = false;
        }
      }
    } else {
      // A fixed-width numeric statistic should never be truncated.  If a
      // caller explicitly marks it inexact, simply refuse to use the upper
      // bound.
      return bounds;
    }
  }

  if (bounds.has_upper) {
    if (!compare_encoded(descriptor, bounds.upper, bounds.upper)) {
      return bounds;
    }
  }

  if (bounds.has_lower && bounds.has_upper) {
    const auto order =
        compare_encoded(descriptor, bounds.lower, bounds.upper);
    if (!order || *order > 0 ||
        (*order == 0 && !bounds.upper_inclusive)) {
      return bounds;
    }
    bounds.singleton = *order == 0 && bounds.upper_inclusive;
  }

  bounds.usable = true;
  return bounds;
}

bool can_satisfy(CompareOp op, const ColumnDescriptor& descriptor,
                 const PageBounds& bounds, const PreparedLiteral& literal,
                 bool any_non_null, bool may_contain_nan) {
  if (!any_non_null) {
    return false;
  }

  switch (literal.kind) {
    case PreparedLiteral::Kind::Invalid:
      // We cannot interpret the literal; never prune.
      return true;
    case PreparedLiteral::Kind::Nan:
      // IEEE comparisons with NaN: only != is true.
      return op == CompareOp::NotEqual;
    case PreparedLiteral::Kind::AboveAll:
      switch (op) {
        case CompareOp::Equal:
          return false;
        case CompareOp::NotEqual:
        case CompareOp::Less:
        case CompareOp::LessEqual:
          return true;
        case CompareOp::Greater:
        case CompareOp::GreaterEqual:
          return false;
      }
      return true;
    case PreparedLiteral::Kind::BelowAll:
      switch (op) {
        case CompareOp::Equal:
          return false;
        case CompareOp::NotEqual:
        case CompareOp::Greater:
        case CompareOp::GreaterEqual:
          return true;
        case CompareOp::Less:
        case CompareOp::LessEqual:
          return false;
      }
      return true;
    case PreparedLiteral::Kind::Encoded:
      break;
  }

  if (!bounds.usable) {
    return true;
  }

  if (op == CompareOp::NotEqual) {
    if (bounds.singleton && !may_contain_nan) {
      const auto equal =
          compare_encoded(descriptor, literal.bytes, bounds.lower);
      if (equal && *equal == 0) {
        return false;
      }
    }
    return true;
  }

  if (op == CompareOp::Equal) {
    if (bounds.has_lower) {
      const auto order = compare_encoded(descriptor, literal.bytes,
                                         bounds.lower);
      if (!order) {
        return true;
      }
      if (*order < 0) {
        return false;
      }
    }
    if (bounds.has_upper) {
      const auto order = compare_encoded(descriptor, literal.bytes,
                                         bounds.upper);
      if (!order) {
        return true;
      }
      if (bounds.upper_inclusive ? *order > 0 : *order >= 0) {
        return false;
      }
    }
    return true;
  }

  if (op == CompareOp::Less || op == CompareOp::LessEqual) {
    if (!bounds.has_lower) {
      return true;
    }
    const auto order =
        compare_encoded(descriptor, bounds.lower, literal.bytes);
    if (!order) {
      return true;
    }
    if (op == CompareOp::Less) {
      return *order < 0;  // lower must be strictly below the literal
    }
    return *order <= 0;
  }

  if (!bounds.has_upper) {
    return true;
  }
  const auto order =
      compare_encoded(descriptor, bounds.upper, literal.bytes);
  if (!order) {
    return true;
  }
  if (op == CompareOp::Greater) {
    // All values are <= upper (inclusive) or < upper (exclusive).  There can
    // be a value greater than the literal only if upper is greater.
    return *order > 0;
  }
  // GreaterEqual
  if (bounds.upper_inclusive) {
    return *order >= 0;
  }
  return *order > 0;
}

struct Cardinality {
  bool empty = false;
  bool any_null = true;
  bool any_non_null = true;
};

Cardinality cardinality(const PageStatistics& stats, bool nested_repeated) {
  Cardinality result;
  if (stats.has_num_values && stats.num_values == 0) {
    if (nested_repeated) {
      // An empty repeated page may still represent rows whose lists are
      // empty.  Keep IS NULL alive instead of treating the page as having no
      // rows at all.
      result.any_null = true;
      result.any_non_null = false;
      return result;
    }
    result.empty = true;
    result.any_null = false;
    result.any_non_null = false;
    return result;
  }
  if (stats.all_null) {
    result.any_null = true;
    result.any_non_null = false;
    return result;
  }
  if (stats.has_null_count) {
    result.any_null = stats.null_count > 0;
    if (stats.has_num_values) {
      result.any_non_null = stats.null_count < stats.num_values;
      result.any_null = stats.null_count > 0;
    } else {
      // There is no value count, but we can still prove that no null exists.
      result.any_non_null = true;
    }
  }
  return result;
}

Truth evaluate_expression(const ColumnDescriptor& descriptor,
                          const PageStatistics& stats,
                          const Expr& expression) {
  const Cardinality card = cardinality(stats, descriptor.nested_repeated);
  if (card.empty) {
    return Truth{false, false};
  }

  switch (expression.kind) {
    case Expr::Kind::True:
      return Truth{true, false};
    case Expr::Kind::False:
      return Truth{false, true};
    case Expr::Kind::Compare: {
      if (!card.any_non_null) {
        return Truth{false, false};
      }
      const PageBounds bounds = build_bounds(descriptor, stats);
      const PreparedLiteral literal =
          prepare_literal(descriptor, expression.literal);
      const bool may_true =
          can_satisfy(expression.op, descriptor, bounds, literal,
                      card.any_non_null, stats.may_contain_nan);

      bool may_false = false;
      if (card.any_non_null) {
        if (literal.kind == PreparedLiteral::Kind::Nan) {
          // Every non-NaN comparison with NaN is false.  The only exception
          // is !=, which is true for all non-null values.
          may_false = expression.op != CompareOp::NotEqual;
        } else if (stats.may_contain_nan) {
          // A NaN value in the page compares false for every op except !=.
          // Since statistics cannot prove NaN's absence, keep a NOT(...)
          // predicate alive as well.
          may_false = true;
        } else {
          // Without NaN, exactly one of op and its negation holds for any
          // non-null value.
          may_false =
              can_satisfy(negate(expression.op), descriptor, bounds, literal,
                          card.any_non_null, stats.may_contain_nan);
        }
      }
      return Truth{may_true, may_false};
    }
    case Expr::Kind::IsNull:
      return Truth{card.any_null, card.any_non_null};
    case Expr::Kind::IsNotNull:
      return Truth{card.any_non_null, card.any_null};
    case Expr::Kind::IsNaN: {
      const bool nan_possible =
          card.any_non_null && stats.may_contain_nan;
      return Truth{nan_possible, card.any_non_null};
    }
    case Expr::Kind::IsNotNaN: {
      const bool nan_possible =
          card.any_non_null && stats.may_contain_nan;
      return Truth{card.any_non_null, nan_possible};
    }
    case Expr::Kind::Not: {
      if (expression.children.size() != 1) {
        return Truth{true, true};
      }
      const Truth child =
          evaluate_expression(descriptor, stats, expression.children.front());
      return Truth{child.may_false, child.may_true};
    }
    case Expr::Kind::And: {
      if (expression.children.empty()) {
        return Truth{true, false};
      }
      Truth result{true, false};
      for (const Expr& child : expression.children) {
        const Truth value = evaluate_expression(descriptor, stats, child);
        result.may_true = result.may_true && value.may_true;
        result.may_false = result.may_false || value.may_false;
      }
      return result;
    }
    case Expr::Kind::Or: {
      if (expression.children.empty()) {
        return Truth{false, true};
      }
      Truth result{false, true};
      for (const Expr& child : expression.children) {
        const Truth value = evaluate_expression(descriptor, stats, child);
        result.may_true = result.may_true || value.may_true;
        result.may_false = result.may_false && value.may_false;
      }
      return result;
    }
  }
  return Truth{true, true};
}

bool compare_value_to_literal(CompareOp op, const ColumnDescriptor& descriptor,
                              std::string_view value,
                              const PreparedLiteral& literal) {
  if (literal.kind == PreparedLiteral::Kind::Invalid) {
    return false;
  }
  if (is_floating(descriptor.physical_type) &&
      encoded_is_nan(descriptor, value)) {
    // NaN compares unequal to everything, including another NaN.
    return op == CompareOp::NotEqual;
  }

  switch (literal.kind) {
    case PreparedLiteral::Kind::Invalid:
      return false;
    case PreparedLiteral::Kind::Nan:
      return op == CompareOp::NotEqual;
    case PreparedLiteral::Kind::AboveAll:
      return op == CompareOp::NotEqual || op == CompareOp::Less ||
             op == CompareOp::LessEqual;
    case PreparedLiteral::Kind::BelowAll:
      return op == CompareOp::NotEqual || op == CompareOp::Greater ||
             op == CompareOp::GreaterEqual;
    case PreparedLiteral::Kind::Encoded:
      break;
  }

  const auto order = compare_encoded(descriptor, value, literal.bytes);
  if (!order) {
    return false;
  }
  switch (op) {
    case CompareOp::Equal:
      return *order == 0;
    case CompareOp::NotEqual:
      return *order != 0;
    case CompareOp::Less:
      return *order < 0;
    case CompareOp::LessEqual:
      return *order <= 0;
    case CompareOp::Greater:
      return *order > 0;
    case CompareOp::GreaterEqual:
      return *order >= 0;
  }
  return false;
}

Tri tri_not(Tri value) {
  switch (value) {
    case Tri::True:
      return Tri::False;
    case Tri::False:
      return Tri::True;
    case Tri::Null:
      return Tri::Null;
  }
  return Tri::Null;
}

Tri tri_and(Tri left, Tri right) {
  if (left == Tri::False || right == Tri::False) {
    return Tri::False;
  }
  if (left == Tri::Null || right == Tri::Null) {
    return Tri::Null;
  }
  return Tri::True;
}

Tri tri_or(Tri left, Tri right) {
  if (left == Tri::True || right == Tri::True) {
    return Tri::True;
  }
  if (left == Tri::Null || right == Tri::Null) {
    return Tri::Null;
  }
  return Tri::False;
}

Tri evaluate_row_expression(const ColumnDescriptor& descriptor,
                            const Expr& expression,
                            const std::vector<ScannedValue>& row) {
  switch (expression.kind) {
    case Expr::Kind::True:
      return Tri::True;
    case Expr::Kind::False:
      return Tri::False;
    case Expr::Kind::Compare: {
      const PreparedLiteral literal =
          prepare_literal(descriptor, expression.literal);
      if (literal.kind == PreparedLiteral::Kind::Invalid) {
        return Tri::Null;
      }
      bool saw_non_null = false;
      for (const ScannedValue& value : row) {
        if (value.is_null) {
          continue;
        }
        saw_non_null = true;
        if (compare_value_to_literal(expression.op, descriptor, value.bytes,
                                     literal)) {
          return Tri::True;
        }
      }
      return saw_non_null ? Tri::False : Tri::Null;
    }
    case Expr::Kind::IsNull: {
      for (const ScannedValue& value : row) {
        if (!value.is_null) {
          return Tri::False;
        }
      }
      return Tri::True;
    }
    case Expr::Kind::IsNotNull: {
      for (const ScannedValue& value : row) {
        if (!value.is_null) {
          return Tri::True;
        }
      }
      return Tri::False;
    }
    case Expr::Kind::IsNaN: {
      bool saw_non_null = false;
      for (const ScannedValue& value : row) {
        if (value.is_null) {
          continue;
        }
        saw_non_null = true;
        if (encoded_is_nan(descriptor, value.bytes)) {
          return Tri::True;
        }
      }
      return saw_non_null ? Tri::False : Tri::Null;
    }
    case Expr::Kind::IsNotNaN: {
      bool saw_non_null = false;
      for (const ScannedValue& value : row) {
        if (value.is_null) {
          continue;
        }
        saw_non_null = true;
        if (!encoded_is_nan(descriptor, value.bytes)) {
          return Tri::True;
        }
      }
      return saw_non_null ? Tri::False : Tri::Null;
    }
    case Expr::Kind::Not: {
      if (expression.children.size() != 1) {
        return Tri::Null;
      }
      return tri_not(
          evaluate_row_expression(descriptor, expression.children.front(), row));
    }
    case Expr::Kind::And: {
      Tri result = Tri::True;
      for (const Expr& child : expression.children) {
        result = tri_and(
            result, evaluate_row_expression(descriptor, child, row));
      }
      return result;
    }
    case Expr::Kind::Or: {
      Tri result = Tri::False;
      for (const Expr& child : expression.children) {
        result =
            tri_or(result, evaluate_row_expression(descriptor, child, row));
      }
      return result;
    }
  }
  return Tri::Null;
}

bool in_row_ranges(std::span<const RowRange> ranges, std::int64_t row) {
  std::size_t low = 0;
  std::size_t high = ranges.size();
  while (low < high) {
    const std::size_t mid = low + (high - low) / 2;
    if (row < ranges[mid].first_row) {
      high = mid;
    } else if (row >= ranges[mid].end_row) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

}  // namespace

std::size_t ColumnIndex::page_count() const {
  return std::max(
      {null_pages.size(), min_values.size(), max_values.size(),
       null_counts.size(), is_min_value_exact.size(),
       is_max_value_exact.size(), num_values.size(), may_contain_nan.size()});
}

SortOrder default_sort_order(PhysicalType type, LogicalType logical) {
  switch (type) {
    case PhysicalType::Boolean:
      return SortOrder::Unsigned;
    case PhysicalType::Int32:
    case PhysicalType::Int64:
    case PhysicalType::Float:
    case PhysicalType::Double:
      return SortOrder::Signed;
    case PhysicalType::ByteArray:
    case PhysicalType::FixedLenByteArray:
      return logical == LogicalType::Decimal ? SortOrder::Signed
                                             : SortOrder::Unsigned;
    case PhysicalType::Int96:
      return SortOrder::Unknown;
  }
  return SortOrder::Unknown;
}

ColumnDescriptor ColumnDescriptor::make(PhysicalType type,
                                        LogicalType logical) {
  ColumnDescriptor descriptor;
  descriptor.physical_type = type;
  descriptor.logical_type = logical;
  descriptor.sort_order = default_sort_order(type, logical);
  return descriptor;
}

ColumnDescriptor ColumnDescriptor::make(PhysicalType type, SortOrder order,
                                        LogicalType logical) {
  ColumnDescriptor descriptor;
  descriptor.physical_type = type;
  descriptor.logical_type = logical;
  descriptor.sort_order = order;
  return descriptor;
}

bool Literal::is_nan() const {
  if (kind == LiteralKind::Float || kind == LiteralKind::Double) {
    return std::isnan(double_value);
  }
  return false;
}

Literal Literal::Boolean(bool value) {
  Literal result;
  result.kind = LiteralKind::Boolean;
  result.bool_value = value;
  result.bytes.assign(1, value ? '\1' : '\0');
  return result;
}

Literal Literal::Int32(std::int32_t value) {
  Literal result;
  result.kind = LiteralKind::Int32;
  result.signed_value = value;
  result.bytes = store_le32(static_cast<std::uint32_t>(value));
  return result;
}

Literal Literal::UInt32(std::uint32_t value) {
  Literal result;
  result.kind = LiteralKind::UInt32;
  result.unsigned_value = value;
  result.bytes = store_le32(value);
  return result;
}

Literal Literal::Int64(std::int64_t value) {
  Literal result;
  result.kind = LiteralKind::Int64;
  result.signed_value = value;
  result.bytes = store_le64(static_cast<std::uint64_t>(value));
  return result;
}

Literal Literal::UInt64(std::uint64_t value) {
  Literal result;
  result.kind = LiteralKind::UInt64;
  result.unsigned_value = value;
  result.bytes = store_le64(value);
  return result;
}

Literal Literal::Float(float value) {
  Literal result;
  result.kind = LiteralKind::Float;
  result.double_value = static_cast<double>(value);
  result.bytes = store_float(value);
  return result;
}

Literal Literal::Double(double value) {
  Literal result;
  result.kind = LiteralKind::Double;
  result.double_value = value;
  result.bytes = store_double(value);
  return result;
}

Literal Literal::Binary(std::string value) {
  Literal result;
  result.kind = LiteralKind::Binary;
  result.bytes = std::move(value);
  return result;
}

Literal Literal::String(std::string_view value) {
  return Binary(std::string(value));
}

Expr Expr::always_true() { return Expr{}; }

Expr Expr::always_false() {
  Expr result;
  result.kind = Kind::False;
  return result;
}

Expr Expr::compare(CompareOp op, Literal literal) {
  Expr result;
  result.kind = Kind::Compare;
  result.op = op;
  result.literal = std::move(literal);
  return result;
}

Expr Expr::is_null() {
  Expr result;
  result.kind = Kind::IsNull;
  return result;
}

Expr Expr::is_not_null() {
  Expr result;
  result.kind = Kind::IsNotNull;
  return result;
}

Expr Expr::is_nan() {
  Expr result;
  result.kind = Kind::IsNaN;
  return result;
}

Expr Expr::is_not_nan() {
  Expr result;
  result.kind = Kind::IsNotNaN;
  return result;
}

Expr Expr::all(std::vector<Expr> children) {
  Expr result;
  result.kind = Kind::And;
  result.children = std::move(children);
  return result;
}

Expr Expr::any(std::vector<Expr> children) {
  Expr result;
  result.kind = Kind::Or;
  result.children = std::move(children);
  return result;
}

Expr Expr::negate(Expr child) {
  Expr result;
  result.kind = Kind::Not;
  result.children.push_back(std::move(child));
  return result;
}

PageStatistics page_statistics(const ColumnDescriptor& descriptor,
                                const ColumnIndex& index, std::size_t page,
                                const PruningOptions& options) {
  PageStatistics stats;
  stats.all_null = page < index.null_pages.size() && index.null_pages[page];

  if (page < index.min_values.size()) {
    stats.has_min = true;
    stats.min_value = index.min_values[page];
    stats.min_nan = encoded_is_nan(descriptor, stats.min_value);
  }
  if (page < index.max_values.size()) {
    stats.has_max = true;
    stats.max_value = index.max_values[page];
    stats.max_nan = encoded_is_nan(descriptor, stats.max_value);
  }

  const auto exactness = [&](std::string_view value, bool has_value,
                             std::size_t flag_index,
                             const std::vector<bool>& flags) {
    if (has_value && flag_index < flags.size()) {
      return static_cast<bool>(flags[flag_index]);
    }
    if (!is_binary(descriptor.physical_type)) {
      return true;
    }
    if (has_value &&
        descriptor.physical_type == PhysicalType::FixedLenByteArray &&
        descriptor.type_length > 0 &&
        static_cast<std::int32_t>(value.size()) >= descriptor.type_length) {
      return true;
    }
    return options.assume_binary_stats_exact_when_unspecified;
  };

  stats.min_exact =
      exactness(stats.min_value, stats.has_min, page, index.is_min_value_exact);
  stats.max_exact =
      exactness(stats.max_value, stats.has_max, page, index.is_max_value_exact);

  if (page < index.null_counts.size() && index.null_counts[page] >= 0) {
    stats.has_null_count = true;
    stats.null_count = index.null_counts[page];
  }
  if (page < index.num_values.size() && index.num_values[page] >= 0) {
    stats.has_num_values = true;
    stats.num_values = index.num_values[page];
  }

  if (!is_floating(descriptor.physical_type) || stats.all_null) {
    stats.may_contain_nan = false;
  } else if (stats.min_nan || stats.max_nan) {
    stats.may_contain_nan = true;
  } else if (page < index.may_contain_nan.size()) {
    stats.may_contain_nan = index.may_contain_nan[page];
  } else {
    // Parquet statistics do not prove the absence of NaN; they only exclude
    // NaN from min/max.  Without an explicit hint, assume NaN may be present.
    stats.may_contain_nan = true;
  }
  return stats;
}

Truth evaluate_page(const ColumnDescriptor& descriptor,
                    const ColumnIndex& index, std::size_t page,
                    const Expr& expression, const PruningOptions& options) {
  return evaluate_expression(
      descriptor, page_statistics(descriptor, index, page, options), expression);
}

bool page_may_match(const ColumnDescriptor& descriptor,
                    const ColumnIndex& index, std::size_t page,
                    const Expr& expression, const PruningOptions& options) {
  return evaluate_page(descriptor, index, page, expression, options).may_true;
}

std::vector<RowRange> page_row_ranges(const OffsetIndex& offset_index,
                                      std::span<const std::uint32_t> pages,
                                      std::int64_t num_rows) {
  const std::int64_t total_rows =
      num_rows >= 0 ? num_rows : offset_index.num_rows;
  std::vector<RowRange> ranges;
  ranges.reserve(pages.size());

  for (const std::uint32_t page : pages) {
    if (page >= offset_index.page_locations.size()) {
      continue;
    }
    std::int64_t start = offset_index.page_locations[page].first_row_index;
    if (start < 0) {
      start = 0;
    }

    std::int64_t end = 0;
    if (static_cast<std::size_t>(page) + 1 <
        offset_index.page_locations.size()) {
      end = offset_index.page_locations[static_cast<std::size_t>(page) + 1]
                .first_row_index;
    } else if (total_rows >= 0) {
      end = total_rows;
    } else {
      end = start + 1;
    }

    // A repeated column can split one row across several pages.  In that case
    // the next page may have the same first_row_index.  A candidate page must
    // still cover its starting row even when the following page begins in the
    // middle of that row.
    if (end <= start) {
      end = start + 1;
    }
    if (total_rows >= 0) {
      end = std::min(end, total_rows);
    }
    if (end > start) {
      ranges.push_back(RowRange{start, end});
    }
  }

  std::sort(ranges.begin(), ranges.end(),
            [](const RowRange& left, const RowRange& right) {
              if (left.first_row != right.first_row) {
                return left.first_row < right.first_row;
              }
              return left.end_row < right.end_row;
            });
  return ranges;
}

std::vector<RowRange> merge_row_ranges(std::vector<RowRange> ranges,
                                       bool merge_adjacent) {
  ranges.erase(std::remove_if(ranges.begin(), ranges.end(),
                              [](const RowRange& range) {
                                return range.end_row <= range.first_row;
                              }),
               ranges.end());
  std::sort(ranges.begin(), ranges.end(),
            [](const RowRange& left, const RowRange& right) {
              if (left.first_row != right.first_row) {
                return left.first_row < right.first_row;
              }
              return left.end_row < right.end_row;
            });

  std::vector<RowRange> merged;
  merged.reserve(ranges.size());
  for (const RowRange& range : ranges) {
    if (merged.empty()) {
      merged.push_back(range);
      continue;
    }
    RowRange& last = merged.back();
    const bool touches = merge_adjacent ? range.first_row <= last.end_row
                                        : range.first_row < last.end_row;
    if (touches) {
      last.end_row = std::max(last.end_row, range.end_row);
    } else {
      merged.push_back(range);
    }
  }
  return merged;
}

PageSelection select_pages(const ColumnDescriptor& descriptor,
                           const ColumnIndex& column_index,
                           const OffsetIndex& offset_index,
                           const Expr& expression,
                           const PruningOptions& options) {
  PageSelection selection;
  selection.num_rows = offset_index.num_rows;

  const std::size_t page_count =
      std::max(column_index.page_count(), offset_index.page_locations.size());
  for (std::size_t page = 0; page < page_count; ++page) {
    if (page_may_match(descriptor, column_index, page, expression, options)) {
      selection.candidate_pages.push_back(static_cast<std::uint32_t>(page));
    } else {
      selection.pruned_pages.push_back(static_cast<std::uint32_t>(page));
    }
  }

  if (selection.candidate_pages.empty()) {
    selection.row_ranges_complete = true;
    return selection;
  }

  bool unmapped_candidate = false;
  for (const std::uint32_t page : selection.candidate_pages) {
    if (page >= offset_index.page_locations.size()) {
      unmapped_candidate = true;
      break;
    }
  }

  if (unmapped_candidate) {
    selection.row_ranges_complete = false;
    if (offset_index.num_rows >= 0) {
      // An unmapped candidate can contain any row; returning the whole chunk
      // is the only safe row-level answer.
      selection.row_ranges.push_back(RowRange{0, offset_index.num_rows});
    }
    return selection;
  }

  selection.row_ranges =
      page_row_ranges(offset_index, selection.candidate_pages,
                      offset_index.num_rows);
  selection.row_ranges =
      merge_row_ranges(std::move(selection.row_ranges),
                       options.merge_adjacent_row_ranges);

  if (offset_index.num_rows < 0 && !offset_index.page_locations.empty() &&
      selection.candidate_pages.back() ==
          offset_index.page_locations.size() - 1) {
    // Without a chunk row count the final page's end is unknown.  The range
    // returned above only covers its first row.
    selection.row_ranges_complete = false;
  }
  return selection;
}

PageSelection select_pages(const ColumnDescriptor& descriptor,
                           const ColumnIndex& column_index,
                           const Expr& expression,
                           const PruningOptions& options) {
  return select_pages(descriptor, column_index, OffsetIndex{}, expression,
                      options);
}

std::vector<std::uint32_t> select_candidate_pages(
    const ColumnDescriptor& descriptor, const ColumnIndex& column_index,
    const Expr& expression, const PruningOptions& options) {
  return select_pages(descriptor, column_index, expression, options)
      .candidate_pages;
}

PageIndexPruner::PageIndexPruner(ColumnDescriptor descriptor,
                                 PruningOptions options)
    : descriptor_(std::move(descriptor)), options_(options) {}

Truth PageIndexPruner::evaluate(const ColumnIndex& index, std::size_t page,
                                const Expr& expression) const {
  return evaluate_page(descriptor_, index, page, expression, options_);
}

PageSelection PageIndexPruner::select(const ColumnIndex& column_index,
                                      const OffsetIndex& offset_index,
                                      const Expr& expression) const {
  return select_pages(descriptor_, column_index, offset_index, expression,
                      options_);
}

PageSelection PageIndexPruner::select(const ColumnIndex& column_index,
                                      const Expr& expression) const {
  return select_pages(descriptor_, column_index, expression, options_);
}

std::vector<std::uint32_t> PageIndexPruner::candidate_pages(
    const ColumnIndex& index, const Expr& expression) const {
  return select_candidate_pages(descriptor_, index, expression, options_);
}

ScannedValue ScannedValue::Null() { return ScannedValue{}; }

ScannedValue ScannedValue::FromLiteral(const Literal& literal) {
  ScannedValue result;
  result.is_null = false;
  result.bytes = literal.bytes;
  return result;
}

Tri evaluate_row(const ColumnDescriptor& descriptor, const Expr& expression,
                 const std::vector<ScannedValue>& row) {
  return evaluate_row_expression(descriptor, expression, row);
}

VerificationReport verify_selection(
    const PageSelection& selection, std::span<const ScannedPage> scanned_pages,
    const ColumnDescriptor& descriptor, const Expr& expression) {
  VerificationReport report;
  const std::vector<std::uint32_t>& candidates = selection.candidate_pages;
  const std::unordered_set<std::uint32_t> candidate_set(candidates.begin(),
                                                        candidates.end());
  const std::vector<RowRange> row_ranges =
      merge_row_ranges(selection.row_ranges, true);

  std::set<std::int64_t> missed_rows;
  std::set<std::uint32_t> matching_not_selected;
  std::set<std::uint32_t> selected_without_match;

  for (const ScannedPage& page : scanned_pages) {
    bool page_has_match = false;
    for (std::size_t row_offset = 0; row_offset < page.rows.size();
         ++row_offset) {
      if (evaluate_row(descriptor, expression, page.rows[row_offset]) !=
          Tri::True) {
        continue;
      }
      ++report.matching_rows;
      page_has_match = true;

      const std::int64_t row_index =
          page.first_row_index + static_cast<std::int64_t>(row_offset);
      if (!in_row_ranges(row_ranges, row_index)) {
        missed_rows.insert(row_index);
      }
      if (!candidate_set.contains(page.page_index)) {
        matching_not_selected.insert(page.page_index);
      }
    }

    if (page_has_match && !candidate_set.contains(page.page_index)) {
      matching_not_selected.insert(page.page_index);
    }
    if (!page.rows.empty() && candidate_set.contains(page.page_index) &&
        !page_has_match) {
      selected_without_match.insert(page.page_index);
    }
  }

  report.missed_rows.assign(missed_rows.begin(), missed_rows.end());
  report.matching_pages_not_selected.assign(matching_not_selected.begin(),
                                            matching_not_selected.end());
  report.selected_pages_without_match.assign(selected_without_match.begin(),
                                             selected_without_match.end());
  report.ok =
      report.missed_rows.empty() && report.matching_pages_not_selected.empty();
  return report;
}

VerificationReport verify_page_selection(
    std::span<const std::uint32_t> candidate_pages,
    std::span<const ScannedPage> scanned_pages,
    const ColumnDescriptor& descriptor, const Expr& expression) {
  VerificationReport report;
  const std::unordered_set<std::uint32_t> candidate_set(
      candidate_pages.begin(), candidate_pages.end());
  std::set<std::uint32_t> matching_not_selected;
  std::set<std::uint32_t> selected_without_match;

  for (const ScannedPage& page : scanned_pages) {
    bool page_has_match = false;
    for (const auto& row : page.rows) {
      if (evaluate_row(descriptor, expression, row) != Tri::True) {
        continue;
      }
      ++report.matching_rows;
      page_has_match = true;
    }

    if (page_has_match && !candidate_set.contains(page.page_index)) {
      matching_not_selected.insert(page.page_index);
    }
    if (!page.rows.empty() && candidate_set.contains(page.page_index) &&
        !page_has_match) {
      selected_without_match.insert(page.page_index);
    }
  }

  report.matching_pages_not_selected.assign(matching_not_selected.begin(),
                                            matching_not_selected.end());
  report.selected_pages_without_match.assign(selected_without_match.begin(),
                                             selected_without_match.end());
  report.ok = report.matching_pages_not_selected.empty();
  return report;
}

}  // namespace dataeng
