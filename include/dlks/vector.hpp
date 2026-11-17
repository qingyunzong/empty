#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "dlks/value.hpp"

namespace dlks {

// Row indices into the base columns of a Batch. A selection is the unit of
// vectorized work: every expression is evaluated once per selected row and
// produces a Vector aligned positionally with this selection.
using Selection = std::vector<std::uint32_t>;

inline Selection all_rows(std::size_t row_count) {
  Selection selection(row_count);
  for (std::size_t i = 0; i < row_count; ++i) {
    selection[i] = static_cast<std::uint32_t>(i);
  }
  return selection;
}

// A typed, batch-encoded column fragment. Values are stored in typed buffers;
// NULLs are tracked in a parallel byte bitmap (1 == NULL). The null bitmap is
// part of vector equality: a 0 and a NULL are never interchangeable.
class Vector {
 public:
  Vector() = default;
  explicit Vector(Type type, std::size_t size = 0) { reset(type, size); }

  static Vector from_values(Type type, const std::vector<Value>& values) {
    Vector vector(type, values.size());
    for (std::size_t i = 0; i < values.size(); ++i) {
      vector.set(i, values[i]);
    }
    return vector;
  }

  void reset(Type type, std::size_t size) {
    type_ = type;
    nulls_.assign(size, 1);
    bools_.clear();
    ints_.clear();
    doubles_.clear();
    strings_.clear();
    switch (type_) {
      case Type::Bool: bools_.assign(size, false); break;
      case Type::Int64: ints_.assign(size, 0); break;
      case Type::Double: doubles_.assign(size, 0.0); break;
      case Type::String: strings_.assign(size, std::string{}); break;
      case Type::Null: break;
    }
  }

  Type type() const noexcept { return type_; }
  std::size_t size() const noexcept { return nulls_.size(); }
  bool empty() const noexcept { return nulls_.empty(); }

  bool is_null(std::size_t index) const {
    check_index(index);
    return nulls_[index] != 0;
  }

  const std::vector<std::uint8_t>& nulls() const noexcept { return nulls_; }
  std::vector<std::uint8_t>& mutable_nulls() noexcept { return nulls_; }

  const std::vector<std::uint8_t>& bools() const noexcept { return bools_; }
  const std::vector<std::int64_t>& ints() const noexcept { return ints_; }
  const std::vector<double>& doubles() const noexcept { return doubles_; }
  const std::vector<std::string>& strings() const noexcept { return strings_; }

  std::vector<std::uint8_t>& mutable_bools() noexcept { return bools_; }
  std::vector<std::int64_t>& mutable_ints() noexcept { return ints_; }
  std::vector<double>& mutable_doubles() noexcept { return doubles_; }
  std::vector<std::string>& mutable_strings() noexcept { return strings_; }

  void set_null(std::size_t index) {
    check_index(index);
    nulls_[index] = 1;
  }

  void set(std::size_t index, const Value& value) {
    check_index(index);
    if (value.is_null()) {
      nulls_[index] = 1;
      return;
    }
    if (value.type() != type_ || type_ == Type::Null) {
      throw std::invalid_argument("cannot store " + std::string(type_name(value.type())) +
                                  " value in " + std::string(type_name(type_)) + " vector");
    }
    nulls_[index] = 0;
    switch (type_) {
      case Type::Bool: bools_[index] = value.as_bool() ? 1 : 0; break;
      case Type::Int64: ints_[index] = value.as_i64(); break;
      case Type::Double: doubles_[index] = value.as_f64(); break;
      case Type::String: strings_[index] = value.as_string(); break;
      case Type::Null: break;
    }
  }

  void set_bool(std::size_t index, bool value) {
    require_type(Type::Bool);
    check_index(index);
    nulls_[index] = 0;
    bools_[index] = value ? 1 : 0;
  }

  void set_i64(std::size_t index, std::int64_t value) {
    require_type(Type::Int64);
    check_index(index);
    nulls_[index] = 0;
    ints_[index] = value;
  }

  void set_f64(std::size_t index, double value) {
    require_type(Type::Double);
    check_index(index);
    nulls_[index] = 0;
    doubles_[index] = value;
  }

  void set_string(std::size_t index, std::string value) {
    require_type(Type::String);
    check_index(index);
    nulls_[index] = 0;
    strings_[index] = std::move(value);
  }

  bool bool_at(std::size_t index) const {
    require_type(Type::Bool);
    check_value(index);
    return bools_[index] != 0;
  }

  std::int64_t i64_at(std::size_t index) const {
    require_type(Type::Int64);
    check_value(index);
    return ints_[index];
  }

  double f64_at(std::size_t index) const {
    require_type(Type::Double);
    check_value(index);
    return doubles_[index];
  }

  const std::string& string_at(std::size_t index) const {
    require_type(Type::String);
    check_value(index);
    return strings_[index];
  }

  Value value(std::size_t index) const {
    check_index(index);
    if (nulls_[index] != 0) {
      return Value{};
    }
    switch (type_) {
      case Type::Bool: return Value(bool_at(index));
      case Type::Int64: return Value(i64_at(index));
      case Type::Double: return Value(f64_at(index));
      case Type::String: return Value(string_at(index));
      case Type::Null: return Value{};
    }
    return Value{};
  }

  void push(const Value& value) {
    if (value.is_null()) {
      nulls_.push_back(1);
      append_default();
      return;
    }
    if (value.type() != type_ || type_ == Type::Null) {
      throw std::invalid_argument("cannot push " + std::string(type_name(value.type())) +
                                  " value into " + std::string(type_name(type_)) + " vector");
    }
    nulls_.push_back(0);
    switch (type_) {
      case Type::Bool: bools_.push_back(value.as_bool() ? 1 : 0); break;
      case Type::Int64: ints_.push_back(value.as_i64()); break;
      case Type::Double: doubles_.push_back(value.as_f64()); break;
      case Type::String: strings_.push_back(value.as_string()); break;
      case Type::Null: break;
    }
  }

  void reserve(std::size_t size) {
    nulls_.reserve(size);
    switch (type_) {
      case Type::Bool: bools_.reserve(size); break;
      case Type::Int64: ints_.reserve(size); break;
      case Type::Double: doubles_.reserve(size); break;
      case Type::String: strings_.reserve(size); break;
      case Type::Null: break;
    }
  }

  // Exact equality including the null bitmap and the value type.
  bool equals(const Vector& other) const {
    if (type_ != other.type_ || size() != other.size()) {
      return false;
    }
    if (nulls_ != other.nulls_) {
      return false;
    }
    for (std::size_t i = 0; i < size(); ++i) {
      if (nulls_[i] == 0 && value(i) != other.value(i)) {
        return false;
      }
    }
    return true;
  }

  bool operator==(const Vector& other) const { return equals(other); }
  bool operator!=(const Vector& other) const { return !equals(other); }

  std::optional<std::string> first_difference(const Vector& other) const {
    if (type_ != other.type_) {
      return "type: " + std::string(type_name(type_)) + " vs " +
             std::string(type_name(other.type_));
    }
    if (size() != other.size()) {
      return "size: " + std::to_string(size()) + " vs " + std::to_string(other.size());
    }
    for (std::size_t i = 0; i < size(); ++i) {
      const bool lhs_null = nulls_[i] != 0;
      const bool rhs_null = other.nulls_[i] != 0;
      if (lhs_null != rhs_null) {
        return "null bit at " + std::to_string(i) + ": " + (lhs_null ? "null" : "value") +
               " vs " + (rhs_null ? "null" : "value");
      }
      if (!lhs_null && value(i) != other.value(i)) {
        return "value at " + std::to_string(i) + ": " + value(i).repr() + " vs " +
               other.value(i).repr();
      }
    }
    return std::nullopt;
  }

  std::string describe() const {
    std::string out = std::string(type_name(type_)) + "[";
    for (std::size_t i = 0; i < size(); ++i) {
      if (i != 0) {
        out += ", ";
      }
      out += is_null(i) ? "null" : value(i).repr();
    }
    out.push_back(']');
    return out;
  }

 private:
  void check_index(std::size_t index) const {
    if (index >= size()) {
      throw std::out_of_range("vector index " + std::to_string(index) + " out of range (size " +
                              std::to_string(size()) + ")");
    }
  }

  void check_value(std::size_t index) const {
    check_index(index);
    if (nulls_[index] != 0) {
      throw std::logic_error("attempt to read NULL value at index " + std::to_string(index));
    }
  }

  void require_type(Type expected) const {
    if (type_ != expected) {
      throw std::logic_error("vector type is " + std::string(type_name(type_)) + ", expected " +
                             std::string(type_name(expected)));
    }
  }

  void append_default() {
    switch (type_) {
      case Type::Bool: bools_.push_back(0); break;
      case Type::Int64: ints_.push_back(0); break;
      case Type::Double: doubles_.push_back(0.0); break;
      case Type::String: strings_.emplace_back(); break;
      case Type::Null: break;
    }
  }

  Type type_ = Type::Null;
  std::vector<std::uint8_t> nulls_;
  std::vector<std::uint8_t> bools_;
  std::vector<std::int64_t> ints_;
  std::vector<double> doubles_;
  std::vector<std::string> strings_;
};

}  // namespace dlks
