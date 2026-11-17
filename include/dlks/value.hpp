#pragma once

#include <charconv>
#include <cstdint>
#include <limits>
#include <ostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <type_traits>
#include <variant>

namespace dlks {

enum class Type : std::uint8_t { Null, Bool, Int64, Double, String };

constexpr std::string_view type_name(Type type) noexcept {
  switch (type) {
    case Type::Null: return "null";
    case Type::Bool: return "bool";
    case Type::Int64: return "int64";
    case Type::Double: return "double";
    case Type::String: return "string";
  }
  return "?";
}

inline std::ostream& operator<<(std::ostream& os, Type type) { return os << type_name(type); }

namespace detail {

inline std::string quote(std::string_view text) {
  std::string out;
  out.reserve(text.size() + 2);
  out.push_back('"');
  for (const char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out.push_back(c); break;
    }
  }
  out.push_back('"');
  return out;
}

}  // namespace detail

// A dynamically typed SQL-style value. The default state is NULL, which is
// distinct from every non-NULL value (including false and the empty string).
class Value {
 public:
  using Storage = std::variant<std::monostate, bool, std::int64_t, double, std::string>;

  constexpr Value() noexcept = default;
  constexpr Value(std::nullptr_t) noexcept {}
  Value(bool value) : storage_(value) {}
  template <typename Integer,
            std::enable_if_t<std::is_integral_v<Integer> &&
                                 !std::is_same_v<std::remove_cv_t<Integer>, bool>,
                             int> = 0>
  Value(Integer value) : storage_(to_i64(value)) {}
  Value(double value) : storage_(value) {}
  Value(std::string value) : storage_(std::move(value)) {}
  Value(std::string_view value) : storage_(std::string(value)) {}
  Value(const char* value) : storage_(std::string(value)) {}

  Type type() const noexcept {
    switch (storage_.index()) {
      case 0: return Type::Null;
      case 1: return Type::Bool;
      case 2: return Type::Int64;
      case 3: return Type::Double;
      default: return Type::String;
    }
  }

  bool is_null() const noexcept { return std::holds_alternative<std::monostate>(storage_); }

  bool as_bool() const { return std::get<bool>(storage_); }
  std::int64_t as_i64() const { return std::get<std::int64_t>(storage_); }
  double as_f64() const { return std::get<double>(storage_); }
  const std::string& as_string() const { return std::get<std::string>(storage_); }

  const Storage& storage() const noexcept { return storage_; }

  friend bool operator==(const Value& lhs, const Value& rhs) { return lhs.storage_ == rhs.storage_; }
  friend bool operator!=(const Value& lhs, const Value& rhs) { return !(lhs == rhs); }

  std::string to_string() const {
    switch (storage_.index()) {
      case 0:
        return "null";
      case 1:
        return std::get<bool>(storage_) ? "true" : "false";
      case 2:
        return std::to_string(std::get<std::int64_t>(storage_));
      case 3: {
        const double value = std::get<double>(storage_);
        char buffer[64];
        const auto result =
            std::to_chars(buffer, buffer + sizeof(buffer), value, std::chars_format::general);
        if (result.ec == std::errc{}) {
          return std::string(buffer, result.ptr);
        }
        std::ostringstream stream;
        stream.precision(17);
        stream << value;
        return stream.str();
      }
      default:
        return std::get<std::string>(storage_);
    }
  }

  // Diagnostic representation: strings are quoted and escaped.
  std::string repr() const {
    if (type() == Type::String) {
      return detail::quote(as_string());
    }
    return to_string();
  }

 private:
  template <typename Integer>
  static std::int64_t to_i64(Integer value) {
    if constexpr (std::is_unsigned_v<Integer>) {
      if (value > static_cast<std::make_unsigned_t<std::int64_t>>(
                      std::numeric_limits<std::int64_t>::max())) {
        throw std::out_of_range("unsigned integer value out of int64 range");
      }
    }
    return static_cast<std::int64_t>(value);
  }

  Storage storage_{};
};

inline std::ostream& operator<<(std::ostream& os, const Value& value) {
  return os << value.to_string();
}

}  // namespace dlks
