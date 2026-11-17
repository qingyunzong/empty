#include "test_helpers.hpp"

#include <memory>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

TEST(value_semantics) {
  const dlks::Value null;
  CHECK(null.is_null());
  CHECK_EQ(null.type(), dlks::Type::Null);
  CHECK_EQ(null.to_string(), std::string("null"));
  CHECK_EQ(null.repr(), std::string("null"));

  const dlks::Value integer(42);
  const dlks::Value number(3.5);
  const dlks::Value boolean(true);
  const dlks::Value text(std::string("a\"b"));
  CHECK_EQ(integer.type(), dlks::Type::Int64);
  CHECK_EQ(number.type(), dlks::Type::Double);
  CHECK_EQ(boolean.type(), dlks::Type::Bool);
  CHECK_EQ(text.type(), dlks::Type::String);
  CHECK_EQ(integer.to_string(), std::string("42"));
  CHECK_EQ(number.to_string(), std::string("3.5"));
  CHECK_EQ(dlks::Value(42.0).to_string(), std::string("42"));
  CHECK_EQ(text.repr(), std::string("\"a\\\"b\""));

  CHECK(dlks::Value(1) == dlks::Value(1));
  CHECK(dlks::Value(1) != dlks::Value(1.0));
  CHECK(dlks::Value(false) != null);
  CHECK(dlks::Value(std::string("")) != null);
  CHECK_EQ(dlks::Value(std::size_t{7}), dlks::Value(7));
  CHECK_EQ(dlks::Value(static_cast<unsigned>(9)), dlks::Value(9));
  CHECK_THROWS_AS(
      dlks::Value(std::numeric_limits<std::uint64_t>::max()),
      std::out_of_range);
}

TEST(vector_null_bitmap_semantics) {
  dlks::Vector vector(dlks::Type::Int64, 3);
  CHECK_EQ(vector.size(), std::size_t(3));
  CHECK(vector.is_null(0));
  CHECK(vector.is_null(1));
  CHECK(vector.is_null(2));

  vector.set_i64(1, 42);
  CHECK(!vector.is_null(1));
  CHECK_EQ(vector.value(1), dlks::Value(42));
  CHECK_EQ(vector.describe(), std::string("int64[null, 42, null]"));
  CHECK_EQ(vector.nulls(), (std::vector<std::uint8_t>{1, 0, 1}));

  CHECK_THROWS_AS(vector.set(0, dlks::Value("x")), std::invalid_argument);
  CHECK_THROWS_AS(vector.i64_at(0), std::logic_error);

  dlks::Vector copy = vector;
  CHECK(copy == vector);
  copy.set_i64(0, 0);
  CHECK(copy != vector);
  const auto difference = copy.first_difference(vector);
  CHECK(difference.has_value());
  CHECK(difference->find("null bit") != std::string::npos);

  dlks::Vector null_value(dlks::Type::Int64, 1);
  dlks::Vector zero_value(dlks::Type::Int64, 1);
  zero_value.set_i64(0, 0);
  CHECK(null_value != zero_value);

  dlks::Vector strings(dlks::Type::String, 2);
  strings.set_string(0, "hello");
  CHECK_EQ(strings.describe(), std::string("string[\"hello\", null]"));

  CHECK_EQ(dlks::all_rows(3), (dlks::Selection{0, 1, 2}));
}

TEST(dictionary_materializes_only_selected_codes) {
  auto dictionary = dlks::make_table_dictionary(
      {0, 1, 0, 2}, {dlks::Value("a"), dlks::Value("b"), dlks::Value("c")}, "dict");
  CHECK_EQ(dictionary->materializations(), std::size_t(0));

  const dlks::ReadResult first = dictionary->read({0, 2});
  CHECK_EQ(first.values.describe(), std::string("string[\"a\", \"a\"]"));
  CHECK(first.errors.empty() || (first.errors[0].empty() && first.errors[1].empty()));
  CHECK_EQ(dictionary->materializations(), std::size_t(1));
  CHECK(dictionary->touched_codes() == (std::vector<std::uint32_t>{0}));

  const dlks::ReadResult second = dictionary->read({3});
  CHECK_EQ(second.values.describe(), std::string("string[\"c\"]"));
  CHECK_EQ(dictionary->materializations(), std::size_t(2));
  CHECK(dictionary->touched_codes() == (std::vector<std::uint32_t>{0, 2}));

  const dlks::ReadResult empty = dictionary->read({});
  CHECK_EQ(empty.values.size(), std::size_t(0));
  CHECK_EQ(dictionary->materializations(), std::size_t(2));
}

TEST(dictionary_failures_are_cached_and_local) {
  auto dictionary = dlks::make_dictionary_column(
      dlks::Type::Int64, {1, 1, 0},
      [](std::uint32_t code) -> dlks::Value {
        if (code == 1) {
          throw std::runtime_error("nope");
        }
        return dlks::Value(7);
      },
      "bad");

  const dlks::ReadResult first = dictionary->read({0, 1, 2});
  CHECK(!first.errors[0].empty());
  CHECK_EQ(first.errors[0], first.errors[1]);
  CHECK(first.errors[0].find("bad: materialization failed for code 1: nope") !=
        std::string::npos);
  CHECK(first.errors[2].empty());
  CHECK_EQ(first.values.value(2), dlks::Value(7));
  CHECK_EQ(dictionary->materializations(), std::size_t(2));

  const dlks::ReadResult second = dictionary->read({0});
  CHECK_EQ(second.errors[0], first.errors[0]);
  CHECK_EQ(dictionary->materializations(), std::size_t(2));
}

TEST(batch_validation) {
  dlks::Batch batch;
  batch.add("a", testhelp::column(testhelp::int_values({dlks::Value(1), dlks::Value(2)})));
  CHECK_EQ(batch.size(), std::size_t(2));
  CHECK(batch.find("a") != nullptr);
  CHECK(batch.find("missing") == nullptr);
  CHECK_THROWS_AS(batch.at("missing"), std::out_of_range);
  CHECK_THROWS_AS(
      batch.add("b", testhelp::column(testhelp::int_values({dlks::Value(1)}))),
      std::invalid_argument);
  CHECK_THROWS_AS(batch.add("", testhelp::column(testhelp::int_values({}))),
                  std::invalid_argument);
  CHECK_THROWS_AS(batch.add("c", nullptr), std::invalid_argument);
}

TEST(kernel_arithmetic_and_cast_edges) {
  using dlks::Op;
  using dlks::Value;
  const std::int64_t maximum = std::numeric_limits<std::int64_t>::max();
  const std::int64_t minimum = std::numeric_limits<std::int64_t>::min();

  CHECK_THROWS_AS(dlks::apply_binary(Op::Add, Value(maximum), Value(1)),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_binary(Op::Sub, Value(minimum), Value(1)),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_binary(Op::Mul, Value(maximum), Value(2)),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_binary(Op::Mul, Value(minimum), Value(-1)),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_binary(Op::Mul, Value(minimum), Value(3)),
                  dlks::KernelError);
  CHECK_THROWS_AS(
      dlks::apply_binary(Op::Mul, Value(std::int64_t{-4000000000}),
                         Value(std::int64_t{-4000000000})),
      dlks::KernelError);
  CHECK_EQ(dlks::apply_binary(Op::Mul, Value(std::int64_t{-3000000000}),
                              Value(std::int64_t{3000000000})),
           Value(std::int64_t{-9000000000000000000LL}));
  CHECK_EQ(dlks::apply_binary(Op::Mul, Value(maximum), Value(-1)), Value(-maximum));
  CHECK_THROWS_AS(dlks::apply_binary(Op::Div, Value(minimum), Value(-1)),
                  dlks::KernelError);

  CHECK_EQ(dlks::apply_binary(Op::Div, Value(-7), Value(2)), Value(-3));
  CHECK_EQ(dlks::apply_binary(Op::Div, Value(7), Value(-2)), Value(-3));
  CHECK_EQ(dlks::apply_binary(Op::Div, Value(-7), Value(-2)), Value(3));
  CHECK_EQ(dlks::apply_binary(Op::Mod, Value(-7), Value(2)), Value(-1));
  CHECK_EQ(dlks::apply_binary(Op::Mod, Value(7), Value(-2)), Value(1));
  CHECK_EQ(dlks::apply_binary(Op::Mod, Value(minimum), Value(-1)), Value(0));

  CHECK_THROWS_AS(dlks::apply_binary(Op::Div, Value(1), Value(0)),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_binary(Op::Mod, Value(1), Value(0)),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_binary(Op::Div, Value(1.0), Value(0.0)),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_binary(Op::Mul, Value(1e308), Value(10.0)),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_binary(Op::Add, Value(1e308), Value(1e308)),
                  dlks::KernelError);
  CHECK_EQ(dlks::apply_binary(Op::Div, Value(2.5), Value(0.5)), Value(5.0));
  CHECK_EQ(dlks::apply_binary(Op::Add, Value(2), Value(0.5)), Value(2.5));

  CHECK_EQ(dlks::apply_binary(Op::Add, Value{}, Value(1)), Value{});
  CHECK_EQ(dlks::apply_binary(Op::Eq, Value{}, Value{}), Value{});
  CHECK_EQ(dlks::apply_binary(Op::Lt, Value(2), Value(2.5)), Value(true));
  CHECK_EQ(dlks::apply_binary(Op::Lt, Value("a"), Value("b")), Value(true));
  CHECK_EQ(dlks::apply_binary(Op::Lt, Value(false), Value(true)), Value(true));
  CHECK_EQ(dlks::apply_binary(Op::Eq, Value(maximum), Value(maximum - 1)),
           Value(false));
  CHECK_EQ(dlks::apply_binary(Op::Eq, Value(std::int64_t{9007199254740993LL}),
                              Value(9007199254740992.0)),
           Value(false));
  CHECK_EQ(dlks::apply_binary(Op::Gt, Value(std::int64_t{9007199254740993LL}),
                              Value(9007199254740992.0)),
           Value(true));
  CHECK_EQ(dlks::apply_binary(Op::Lt, Value(maximum), Value(9223372036854775808.0)),
           Value(true));
  CHECK_EQ(dlks::apply_binary(Op::Eq, Value(minimum), Value(-9223372036854775808.0)),
           Value(true));

  CHECK_EQ(dlks::apply_unary(Op::Neg, Value{}), Value{});
  CHECK_EQ(dlks::apply_unary(Op::Not, Value{}), Value{});
  CHECK_EQ(dlks::apply_unary(Op::Not, Value(false)), Value(true));
  CHECK_THROWS_AS(dlks::apply_unary(Op::Neg, Value(minimum)), dlks::KernelError);

  CHECK_EQ(dlks::apply_cast(Value("42"), dlks::Type::Int64), Value(42));
  CHECK_EQ(dlks::apply_cast(Value("-9223372036854775808"), dlks::Type::Int64),
           Value(minimum));
  CHECK_THROWS_AS(dlks::apply_cast(Value(" 42"), dlks::Type::Int64),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_cast(Value("+42"), dlks::Type::Int64),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_cast(Value("42x"), dlks::Type::Int64),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_cast(Value(""), dlks::Type::Int64),
                  dlks::KernelError);
  CHECK_EQ(dlks::apply_cast(Value(2.999), dlks::Type::Int64), Value(2));
  CHECK_EQ(dlks::apply_cast(Value(-2.999), dlks::Type::Int64), Value(-2));
  CHECK_EQ(dlks::apply_cast(Value(-9223372036854775808.0), dlks::Type::Int64),
           Value(minimum));
  CHECK_THROWS_AS(dlks::apply_cast(Value(9223372036854775808.0), dlks::Type::Int64),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_cast(Value(1e300), dlks::Type::Int64),
                  dlks::KernelError);

  CHECK_EQ(dlks::apply_cast(Value(true), dlks::Type::String), Value("true"));
  CHECK_EQ(dlks::apply_cast(Value(3.5), dlks::Type::String), Value("3.5"));
  CHECK_EQ(dlks::apply_cast(Value(2.0), dlks::Type::String), Value("2"));
  CHECK_EQ(dlks::apply_cast(Value(minimum), dlks::Type::String),
           Value("-9223372036854775808"));
  CHECK_EQ(dlks::apply_cast(Value("false"), dlks::Type::Bool), Value(false));
  CHECK_THROWS_AS(dlks::apply_cast(Value("FALSE"), dlks::Type::Bool),
                  dlks::KernelError);
  CHECK_EQ(dlks::apply_cast(Value(0.0), dlks::Type::Bool), Value(false));
  CHECK_EQ(dlks::apply_cast(Value(9), dlks::Type::Bool), Value(true));
  CHECK_EQ(dlks::apply_cast(Value("1e3"), dlks::Type::Double), Value(1000.0));
  CHECK_THROWS_AS(dlks::apply_cast(Value("1e309"), dlks::Type::Double),
                  dlks::KernelError);
  CHECK_THROWS_AS(dlks::apply_cast(Value("nan"), dlks::Type::Double),
                  dlks::KernelError);
  CHECK_EQ(dlks::apply_cast(Value{}, dlks::Type::String), Value{});
}
