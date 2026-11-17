#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "dlks/column.hpp"
#include "dlks/expr.hpp"
#include "dlks/value.hpp"
#include "dlks/vector.hpp"

namespace dlks {

struct DatasetSpec {
  std::size_t rows = 0;
  std::vector<Value> ints;
  std::vector<Value> doubles;
  std::vector<Value> bools;
  std::vector<Value> strings;
  std::vector<std::uint8_t> int_nulls;
  std::vector<std::uint8_t> double_nulls;
  std::vector<std::uint8_t> bool_nulls;
  std::vector<std::uint8_t> string_nulls;
  std::vector<std::uint32_t> dict_codes;
  std::vector<Value> dict_table;
  std::vector<std::uint8_t> dict_failures;
};

inline DatasetSpec random_dataset(std::mt19937_64& rng, std::size_t rows) {
  if (rows == 0) {
    throw std::invalid_argument("random_dataset requires at least one row");
  }
  DatasetSpec spec;
  spec.rows = rows;

  const auto coin = [&rng](unsigned numerator, unsigned denominator) {
    return static_cast<unsigned>(rng() % denominator) < numerator;
  };
  const auto between = [&rng](int low, int high) {
    return low + static_cast<int>(rng() % static_cast<unsigned>(high - low + 1));
  };

  const std::int64_t int_pool[] = {0, 1, -1, 2, 7, 42, -5, 1000, 123456};
  const double double_pool[] = {0.0, 1.0, -1.0, 2.5, 0.5, -3.75, 100.0, 1234.5};
  const char* string_pool[] = {"",       "0",    "1",     "-7",    "42",
                               "3.5",    "-2.25", "true",  "false", "abc",
                               " 9",     "12x",  "999999999999999999999"};

  spec.ints.reserve(rows);
  spec.doubles.reserve(rows);
  spec.bools.reserve(rows);
  spec.strings.reserve(rows);
  spec.int_nulls.reserve(rows);
  spec.double_nulls.reserve(rows);
  spec.bool_nulls.reserve(rows);
  spec.string_nulls.reserve(rows);

  for (std::size_t row = 0; row < rows; ++row) {
    if (coin(1, 20)) {
      const int extreme = between(0, 3);
      switch (extreme) {
        case 0: spec.ints.emplace_back(std::numeric_limits<std::int64_t>::min()); break;
        case 1: spec.ints.emplace_back(std::numeric_limits<std::int64_t>::max()); break;
        case 2: spec.ints.emplace_back(std::numeric_limits<std::int64_t>::min() + 1); break;
        default: spec.ints.emplace_back(std::numeric_limits<std::int64_t>::max() - 1); break;
      }
    } else if (coin(1, 4)) {
      spec.ints.push_back(Value(static_cast<std::int64_t>(between(-20, 20))));
    } else {
      spec.ints.push_back(Value(static_cast<std::int64_t>(int_pool[between(0, 8)])));
    }
    spec.int_nulls.push_back(coin(1, 8) ? 1 : 0);

    spec.doubles.push_back(Value(double_pool[between(0, 7)]));
    spec.double_nulls.push_back(coin(1, 8) ? 1 : 0);

    spec.bools.push_back(Value(coin(1, 2) != 0));
    spec.bool_nulls.push_back(coin(1, 8) ? 1 : 0);

    spec.strings.emplace_back(string_pool[between(0, 11)]);
    spec.string_nulls.push_back(coin(1, 8) ? 1 : 0);
  }

  const std::size_t table_size = 4 + static_cast<std::size_t>(between(0, 4));
  spec.dict_table.reserve(table_size);
  spec.dict_failures.assign(table_size, 0);
  for (std::size_t code = 0; code < table_size; ++code) {
    if (code != 0 && coin(1, 8)) {
      spec.dict_table.emplace_back();
    } else {
      spec.dict_table.emplace_back(string_pool[between(0, 11)]);
    }
    if (code != 0 && coin(1, 6)) {
      spec.dict_failures[code] = 1;
    }
  }
  if (table_size > 1 && coin(1, 2)) {
    spec.dict_failures[table_size - 1] = 1;
  }

  spec.dict_codes.reserve(rows);
  for (std::size_t row = 0; row < rows; ++row) {
    spec.dict_codes.push_back(static_cast<std::uint32_t>(between(0, static_cast<int>(table_size) - 1)));
  }
  return spec;
}

inline Vector build_vector(Type type, const std::vector<Value>& values,
                           const std::vector<std::uint8_t>& nulls) {
  if (values.size() != nulls.size()) {
    throw std::invalid_argument("value/null vector size mismatch");
  }
  Vector vector(type, values.size());
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (nulls[i] != 0) {
      vector.set_null(i);
    } else {
      vector.set(i, values[i]);
    }
  }
  return vector;
}

inline Batch make_batch(const DatasetSpec& spec) {
  Batch batch;
  batch.add("i", std::make_shared<InMemoryColumn>(
                     build_vector(Type::Int64, spec.ints, spec.int_nulls)));
  batch.add("d", std::make_shared<InMemoryColumn>(
                     build_vector(Type::Double, spec.doubles, spec.double_nulls)));
  batch.add("b", std::make_shared<InMemoryColumn>(
                     build_vector(Type::Bool, spec.bools, spec.bool_nulls)));
  batch.add("s", std::make_shared<InMemoryColumn>(
                     build_vector(Type::String, spec.strings, spec.string_nulls)));

  auto table = std::make_shared<std::vector<Value>>(spec.dict_table);
  auto failures = std::make_shared<std::vector<std::uint8_t>>(spec.dict_failures);
  batch.add("dict", make_dictionary_column(
                        Type::String, spec.dict_codes,
                        [table, failures](std::uint32_t code) -> Value {
                          if (code >= table->size()) {
                            throw std::out_of_range("code out of range");
                          }
                          if (code < failures->size() && (*failures)[code] != 0) {
                            throw std::runtime_error("synthetic dictionary failure");
                          }
                          return (*table)[code];
                        },
                        "dict"));
  return batch;
}

struct CallCounters {
  std::map<std::string, std::uint64_t> calls;
};

inline Registry make_test_registry(std::shared_ptr<CallCounters> counters) {
  Registry registry;
  registry.add({"tick", {Type::Int64}, Type::Int64,
                [counters](const std::vector<Value>& arguments) {
                  ++counters->calls["tick"];
                  return arguments[0];
                }});
  registry.add({"boom", {Type::Int64, Type::Int64}, Type::Int64,
                [counters](const std::vector<Value>& arguments) {
                  ++counters->calls["boom"];
                  const std::int64_t value = arguments[0].as_i64();
                  if (value % 7 == 0) {
                    throw std::runtime_error("boom triggered at input " +
                                             std::to_string(value));
                  }
                  return Value(value ^ arguments[1].as_i64());
                }});
  return registry;
}

// Type-directed random expression generator. Every generated expression is
// statically well typed, but may still fail at runtime (division by zero,
// invalid casts, the boom function, or a failing dictionary code).
class RandomExprGenerator {
 public:
  RandomExprGenerator(std::mt19937_64& rng, const Registry&, int max_depth = 4)
      : rng_(rng), max_depth_(max_depth) {}

  ExprPtr make(Type target) { return generate(target, max_depth_); }

 private:
  bool coin(unsigned numerator, unsigned denominator) {
    return static_cast<unsigned>(rng_() % denominator) < numerator;
  }

  template <typename T, std::size_t N>
  const T& pick(const T (&pool)[N]) {
    return pool[rng_() % N];
  }

  ExprPtr column_of(Type type) {
    switch (type) {
      case Type::Int64: return Expr::column("i");
      case Type::Double: return Expr::column("d");
      case Type::Bool: return Expr::column("b");
      case Type::String: return Expr::column(coin(1, 2) ? "s" : "dict");
      case Type::Null: break;
    }
    return Expr::literal(Value{});
  }

  ExprPtr literal_of(Type type) {
    const std::int64_t ints[] = {0, 1, -1, 2, 7, 42, -5, 1000, -100};
    const double doubles[] = {0.0, 1.0, -1.0, 2.5, 0.5, -3.75, 100.0, 1234.5};
    const char* strings[] = {"",  "0", "1", "-7", "42", "3.5", "-2.25", "true",
                             "false", "abc", " 9", "12x", "999999999999999999999"};
    switch (type) {
      case Type::Int64: return Expr::literal(Value(pick(ints)));
      case Type::Double: return Expr::literal(Value(pick(doubles)));
      case Type::Bool: return Expr::literal(Value(coin(1, 2) != 0));
      case Type::String: return Expr::literal(Value(pick(strings)));
      case Type::Null: break;
    }
    return Expr::literal(Value{});
  }

  ExprPtr leaf(Type type) {
    if (coin(1, 10)) {
      return Expr::literal(Value{});
    }
    if (coin(6, 10)) {
      return column_of(type);
    }
    return literal_of(type);
  }

  ExprPtr comparison(Type operand_type, int depth) {
    const Op ops[] = {Op::Eq, Op::Ne, Op::Lt, Op::Le, Op::Gt, Op::Ge};
    return Expr::binary(pick(ops), generate(operand_type, depth - 1),
                        generate(operand_type, depth - 1));
  }

  // A boolean expression that is likely to be expensive or to fail. Used as
  // the right operand of AND/OR so differential runs exercise row-local
  // short-circuiting and skipped side effects.
  ExprPtr dangerous_bool(int depth) {
    switch (rng_() % 4) {
      case 0:
        return comparison(Type::Int64, depth);
      case 1:
        return Expr::binary(
            Op::Gt,
            Expr::binary(Op::Div, generate(Type::Int64, depth - 1),
                         generate(Type::Int64, depth - 1)),
            Expr::literal(dlks::Value(0)));
      case 2:
        return Expr::binary(
            Op::Ne,
            Expr::call("boom", {generate(Type::Int64, depth - 1),
                                generate(Type::Int64, depth - 1)}),
            Expr::literal(dlks::Value(0)));
      default:
        return Expr::binary(
            Op::Gt, Expr::call("tick", {generate(Type::Int64, depth - 1)}),
            Expr::literal(dlks::Value(-1)));
    }
  }

  ExprPtr generate(Type target, int depth) {
    if (depth <= 0) {
      return leaf(target);
    }
    switch (target) {
      case Type::Int64:
        switch (rng_() % 12) {
          case 0:
            return Expr::binary(Op::Add, generate(Type::Int64, depth - 1),
                                generate(Type::Int64, depth - 1));
          case 1:
            return Expr::binary(Op::Sub, generate(Type::Int64, depth - 1),
                                generate(Type::Int64, depth - 1));
          case 2:
            return Expr::binary(Op::Mul, generate(Type::Int64, depth - 1),
                                generate(Type::Int64, depth - 1));
          case 3:
            return Expr::binary(Op::Div, generate(Type::Int64, depth - 1),
                                generate(Type::Int64, depth - 1));
          case 4:
            return Expr::binary(Op::Mod, generate(Type::Int64, depth - 1),
                                generate(Type::Int64, depth - 1));
          case 5:
            return Expr::unary(Op::Neg, generate(Type::Int64, depth - 1));
          case 6:
            return Expr::cast_to(generate(Type::Double, depth - 1), Type::Int64);
          case 7:
            return Expr::cast_to(generate(Type::String, depth - 1), Type::Int64);
          case 8:
            return Expr::if_then_else(generate(Type::Bool, depth - 1),
                                      generate(Type::Int64, depth - 1),
                                      generate(Type::Int64, depth - 1));
          case 9:
            return Expr::coalesce(generate(Type::Int64, depth - 1),
                                  generate(Type::Int64, depth - 1));
          case 10:
            return Expr::call("boom", {generate(Type::Int64, depth - 1),
                                       generate(Type::Int64, depth - 1)});
          default:
            return Expr::call("tick", {generate(Type::Int64, depth - 1)});
        }
      case Type::Double:
        switch (rng_() % 10) {
          case 0:
            return Expr::binary(Op::Add, generate(Type::Double, depth - 1),
                                generate(Type::Double, depth - 1));
          case 1:
            return Expr::binary(Op::Sub, generate(Type::Double, depth - 1),
                                generate(Type::Double, depth - 1));
          case 2:
            return Expr::binary(Op::Mul, generate(Type::Double, depth - 1),
                                generate(Type::Double, depth - 1));
          case 3:
            return Expr::binary(Op::Div, generate(Type::Double, depth - 1),
                                generate(Type::Double, depth - 1));
          case 4:
            return Expr::unary(Op::Neg, generate(Type::Double, depth - 1));
          case 5:
            return Expr::cast_to(generate(Type::Int64, depth - 1), Type::Double);
          case 6:
            return Expr::cast_to(generate(Type::String, depth - 1), Type::Double);
          case 7:
            return Expr::if_then_else(
                generate(Type::Bool, depth - 1),
                generate(coin(1, 2) ? Type::Int64 : Type::Double, depth - 1),
                generate(Type::Double, depth - 1));
          case 8:
            return Expr::coalesce(generate(Type::Int64, depth - 1),
                                  generate(Type::Double, depth - 1));
          default:
            return leaf(Type::Double);
        }
      case Type::Bool:
        switch (rng_() % 13) {
          case 0:
            return Expr::binary(Op::And, generate(Type::Bool, depth - 1),
                                dangerous_bool(depth - 1));
          case 1:
            return Expr::binary(Op::Or, generate(Type::Bool, depth - 1),
                                dangerous_bool(depth - 1));
          case 2:
            return Expr::binary(Op::And, generate(Type::Bool, depth - 1),
                                generate(Type::Bool, depth - 1));
          case 3:
            return Expr::binary(Op::Or, generate(Type::Bool, depth - 1),
                                generate(Type::Bool, depth - 1));
          case 4:
            return Expr::unary(Op::Not, generate(Type::Bool, depth - 1));
          case 5:
            return comparison(Type::Int64, depth);
          case 6:
            return comparison(Type::Double, depth);
          case 7:
            return comparison(Type::String, depth);
          case 8: {
            const Type types[] = {Type::Int64, Type::Double, Type::Bool, Type::String};
            return Expr::is_null(generate(pick(types), depth - 1));
          }
          case 9:
            return Expr::if_then_else(generate(Type::Bool, depth - 1),
                                      generate(Type::Bool, depth - 1),
                                      generate(Type::Bool, depth - 1));
          case 10:
            return Expr::coalesce(generate(Type::Bool, depth - 1),
                                  generate(Type::Bool, depth - 1));
          case 11:
            return Expr::cast_to(generate(Type::Int64, depth - 1), Type::Bool);
          default:
            return leaf(Type::Bool);
        }
      case Type::String:
        switch (rng_() % 6) {
          case 0:
            return Expr::cast_to(generate(Type::Int64, depth - 1), Type::String);
          case 1:
            return Expr::cast_to(generate(Type::Double, depth - 1), Type::String);
          case 2:
            return Expr::cast_to(generate(Type::Bool, depth - 1), Type::String);
          case 3:
            return Expr::if_then_else(generate(Type::Bool, depth - 1),
                                      generate(Type::String, depth - 1),
                                      generate(Type::String, depth - 1));
          case 4:
            return Expr::coalesce(generate(Type::String, depth - 1),
                                  generate(Type::String, depth - 1));
          default:
            return leaf(Type::String);
        }
      case Type::Null:
        break;
    }
    return Expr::literal(Value{});
  }

  std::mt19937_64& rng_;
  int max_depth_;
};

inline std::vector<Selection> random_selections(std::mt19937_64& rng, std::size_t rows) {
  std::vector<Selection> selections;
  selections.push_back(all_rows(rows));
  selections.push_back(Selection{});

  Selection subset;
  subset.reserve(rows);
  for (std::uint32_t row = 0; row < rows; ++row) {
    if (rng() % 3 != 0) {
      subset.push_back(row);
    }
  }
  selections.push_back(subset);

  Selection duplicates;
  if (rows > 0) {
    const std::size_t count = 1 + static_cast<std::size_t>(rng() % (rows * 2));
    duplicates.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
      duplicates.push_back(static_cast<std::uint32_t>(rng() % rows));
    }
  }
  selections.push_back(duplicates);

  Selection reversed = all_rows(rows);
  std::reverse(reversed.begin(), reversed.end());
  selections.push_back(reversed);

  Selection shuffled = all_rows(rows);
  std::shuffle(shuffled.begin(), shuffled.end(), rng);
  selections.push_back(shuffled);

  return selections;
}

}  // namespace dlks
