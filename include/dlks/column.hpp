#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "dlks/value.hpp"
#include "dlks/vector.hpp"

namespace dlks {

struct ReadResult {
  Vector values;
  // Parallel to the selection. An empty string means the row decoded
  // successfully; a non-empty string is the row-local error message.
  std::vector<std::string> errors;
};

class Column {
 public:
  virtual ~Column() = default;

  virtual Type type() const noexcept = 0;
  virtual std::size_t size() const noexcept = 0;
  virtual Value value(std::uint32_t row) const = 0;

  // Batch decode. Implementations must return exactly selection.size() values
  // and exactly selection.size() error slots.
  virtual ReadResult read(const Selection& selection) const {
    ReadResult result{Vector(type(), selection.size()),
                      std::vector<std::string>(selection.size())};
    for (std::size_t i = 0; i < selection.size(); ++i) {
      if (selection[i] >= size()) {
        result.errors[i] = "row index " + std::to_string(selection[i]) + " out of range";
        continue;
      }
      try {
        result.values.set(i, value(selection[i]));
      } catch (const std::exception& error) {
        result.errors[i] = error.what();
      } catch (...) {
        result.errors[i] = "column read failed";
      }
    }
    return result;
  }
};

class InMemoryColumn final : public Column {
 public:
  explicit InMemoryColumn(Vector data) : data_(std::move(data)) {}

  Type type() const noexcept override { return data_.type(); }
  std::size_t size() const noexcept override { return data_.size(); }

  Value value(std::uint32_t row) const override {
    if (row >= data_.size()) {
      throw std::out_of_range("row " + std::to_string(row) + " out of range");
    }
    return data_.value(row);
  }

  const Vector& data() const noexcept { return data_; }

  ReadResult read(const Selection& selection) const override {
    ReadResult result{Vector(data_.type(), selection.size()),
                      std::vector<std::string>(selection.size())};
    for (std::size_t i = 0; i < selection.size(); ++i) {
      if (selection[i] >= data_.size()) {
        result.errors[i] = "row index " + std::to_string(selection[i]) + " out of range";
        continue;
      }
      result.values.set(i, data_.value(selection[i]));
    }
    return result;
  }

 private:
  Vector data_;
};

// Dictionary encoded column. Codes are stored per row; values are materialized
// on first use and cached per code. Decoding a selection therefore touches
// only the distinct codes referenced by that selection, and rows that are
// short-circuited never cause their codes to be materialized.
class DictionaryColumn final : public Column {
 public:
  using Provider = std::function<Value(std::uint32_t code)>;

  DictionaryColumn(Type type, std::vector<std::uint32_t> codes, Provider provider,
                   std::string label = "dictionary")
      : type_(type),
        codes_(std::move(codes)),
        provider_(std::move(provider)),
        label_(std::move(label)) {
    if (type_ == Type::Null) {
      throw std::invalid_argument("dictionary column must have a concrete value type");
    }
    if (!provider_) {
      throw std::invalid_argument("dictionary column requires a provider");
    }
  }

  Type type() const noexcept override { return type_; }
  std::size_t size() const noexcept override { return codes_.size(); }

  const std::string& label() const noexcept { return label_; }
  const std::vector<std::uint32_t>& codes() const noexcept { return codes_; }

  Value value(std::uint32_t row) const override {
    if (row >= codes_.size()) {
      throw std::out_of_range("row " + std::to_string(row) + " out of range");
    }
    return lookup(codes_[row]);
  }

  ReadResult read(const Selection& selection) const override {
    ReadResult result{Vector(type_, selection.size()),
                      std::vector<std::string>(selection.size())};
    for (std::size_t i = 0; i < selection.size(); ++i) {
      if (selection[i] >= codes_.size()) {
        result.errors[i] = "row index " + std::to_string(selection[i]) + " out of range";
        continue;
      }
      try {
        result.values.set(i, lookup(codes_[selection[i]]));
      } catch (const std::exception& error) {
        result.errors[i] = error.what();
      } catch (...) {
        result.errors[i] = "dictionary materialization failed";
      }
    }
    return result;
  }

  // Number of provider invocations (successful or not).
  std::size_t materializations() const noexcept { return provider_calls_; }

  // Codes whose materialization was attempted, sorted. Failures are included
  // because the engine observes them; this is used by differential tests.
  std::vector<std::uint32_t> touched_codes() const {
    std::vector<std::uint32_t> codes;
    codes.reserve(cache_.size());
    for (const auto& entry : cache_) {
      codes.push_back(entry.first);
    }
    std::sort(codes.begin(), codes.end());
    return codes;
  }

 private:
  struct CacheEntry {
    bool failed = false;
    Value value;
    std::string error;
  };

  Value lookup(std::uint32_t code) const {
    const auto found = cache_.find(code);
    if (found != cache_.end()) {
      if (found->second.failed) {
        throw std::runtime_error(found->second.error);
      }
      return found->second.value;
    }
    ++provider_calls_;
    try {
      Value value = provider_(code);
      if (!value.is_null() && value.type() != type_) {
        throw std::runtime_error("provider returned " + std::string(type_name(value.type())) +
                                 " for " + std::string(type_name(type_)) + " dictionary");
      }
      cache_.emplace(code, CacheEntry{false, value, {}});
      return value;
    } catch (const std::exception& error) {
      CacheEntry entry;
      entry.failed = true;
      entry.error = label_ + ": materialization failed for code " + std::to_string(code) +
                    ": " + error.what();
      cache_.emplace(code, std::move(entry));
      throw std::runtime_error(cache_.at(code).error);
    } catch (...) {
      CacheEntry entry;
      entry.failed = true;
      entry.error = label_ + ": materialization failed for code " + std::to_string(code) +
                    ": unknown error";
      cache_.emplace(code, std::move(entry));
      throw std::runtime_error(cache_.at(code).error);
    }
  }

  Type type_;
  std::vector<std::uint32_t> codes_;
  Provider provider_;
  std::string label_;
  mutable std::unordered_map<std::uint32_t, CacheEntry> cache_;
  mutable std::size_t provider_calls_ = 0;
};

inline std::shared_ptr<DictionaryColumn> make_dictionary_column(
    Type type, std::vector<std::uint32_t> codes, DictionaryColumn::Provider provider,
    std::string label = "dictionary") {
  return std::make_shared<DictionaryColumn>(type, std::move(codes), std::move(provider),
                                            std::move(label));
}

inline std::shared_ptr<DictionaryColumn> make_table_dictionary(
    std::vector<std::uint32_t> codes, std::vector<Value> table, std::string label = "dictionary") {
  if (table.empty()) {
    throw std::invalid_argument("dictionary table must not be empty");
  }
  Type type = Type::Null;
  for (const Value& value : table) {
    if (value.is_null()) {
      continue;
    }
    if (type == Type::Null) {
      type = value.type();
    } else if (value.type() != type) {
      throw std::invalid_argument("dictionary table has mixed value types");
    }
  }
  if (type == Type::Null) {
    type = Type::String;
  }
  auto shared_table = std::make_shared<std::vector<Value>>(std::move(table));
  return make_dictionary_column(
      type, std::move(codes),
      [shared_table](std::uint32_t code) -> Value {
        if (code >= shared_table->size()) {
          throw std::out_of_range("code " + std::to_string(code) + " out of range");
        }
        return (*shared_table)[code];
      },
      std::move(label));
}

class Batch {
 public:
  void add(std::string name, std::shared_ptr<Column> column) {
    if (name.empty()) {
      throw std::invalid_argument("column name must not be empty");
    }
    if (!column) {
      throw std::invalid_argument("column '" + name + "' must not be null");
    }
    if (has_rows_ && column->size() != rows_) {
      throw std::invalid_argument("column '" + name + "' has " +
                                  std::to_string(column->size()) + " rows, expected " +
                                  std::to_string(rows_));
    }
    rows_ = column->size();
    has_rows_ = true;
    columns_[std::move(name)] = std::move(column);
  }

  const Column* find(std::string_view name) const {
    const auto found = columns_.find(name);
    return found == columns_.end() ? nullptr : found->second.get();
  }

  const Column& at(std::string_view name) const {
    const Column* column = find(name);
    if (column == nullptr) {
      throw std::out_of_range("unknown column '" + std::string(name) + "'");
    }
    return *column;
  }

  std::size_t size() const noexcept { return rows_; }

  const std::map<std::string, std::shared_ptr<Column>, std::less<>>& columns() const noexcept {
    return columns_;
  }

 private:
  std::map<std::string, std::shared_ptr<Column>, std::less<>> columns_;
  std::size_t rows_ = 0;
  bool has_rows_ = false;
};

}  // namespace dlks
