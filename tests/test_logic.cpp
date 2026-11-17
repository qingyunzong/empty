#include "test_helpers.hpp"

#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct Stats {
  std::map<std::string, std::uint64_t> calls;
};

std::shared_ptr<Stats> make_stats() { return std::make_shared<Stats>(); }

dlks::Registry make_danger_registry(const std::shared_ptr<Stats>& stats) {
  dlks::Registry registry;
  registry.add({"danger", {dlks::Type::Int64}, dlks::Type::Int64,
                [stats](const std::vector<dlks::Value>& arguments) {
                  ++stats->calls["danger"];
                  const std::int64_t value = arguments[0].as_i64();
                  if (value == 2) {
                    throw std::runtime_error("danger at 2");
                  }
                  return dlks::Value(value);
                }});
  registry.add({"thenf", {dlks::Type::Int64}, dlks::Type::Int64,
                [stats](const std::vector<dlks::Value>& arguments) {
                  ++stats->calls["thenf"];
                  return dlks::Value(arguments[0].as_i64() + 100);
                }});
  registry.add({"elsef", {dlks::Type::Int64}, dlks::Type::Int64,
                [stats](const std::vector<dlks::Value>& arguments) {
                  ++stats->calls["elsef"];
                  return dlks::Value(arguments[0].as_i64() - 100);
                }});
  registry.add({"side", {dlks::Type::Int64}, dlks::Type::Int64,
                [stats](const std::vector<dlks::Value>& arguments) {
                  ++stats->calls["side"];
                  return dlks::Value(arguments[0].as_i64());
                }});
  registry.add({"side_boom", {dlks::Type::Int64}, dlks::Type::Int64,
                [stats](const std::vector<dlks::Value>& arguments) {
                  ++stats->calls["side_boom"];
                  if (arguments[0].as_i64() == 2) {
                    throw std::runtime_error("side boom at 2");
                  }
                  return dlks::Value(arguments[0].as_i64());
                }});
  registry.add({"combine", {dlks::Type::Int64, dlks::Type::Int64}, dlks::Type::Int64,
                [stats](const std::vector<dlks::Value>& arguments) {
                  ++stats->calls["combine"];
                  return dlks::Value(arguments[1].as_i64());
                }});
  return registry;
}

dlks::ExprPtr three_value(int state) {
  if (state < 0) {
    return dlks::Expr::literal(dlks::Value{});
  }
  return dlks::Expr::literal(dlks::Value(state == 1));
}

dlks::Value expected_logic(dlks::Op op, int lhs, int rhs) {
  if (op == dlks::Op::And) {
    if (lhs == 0 || rhs == 0) {
      return dlks::Value(false);
    }
    if (lhs == 1 && rhs == 1) {
      return dlks::Value(true);
    }
    return dlks::Value{};
  }
  if (lhs == 1 || rhs == 1) {
    return dlks::Value(true);
  }
  if (lhs == 0 && rhs == 0) {
    return dlks::Value(false);
  }
  return dlks::Value{};
}

const char* state_name(int state) {
  return state < 0 ? "NULL" : (state == 0 ? "FALSE" : "TRUE");
}

void check_both(const dlks::Batch& batch, const dlks::Registry& registry,
                const dlks::ExprPtr& expression, const dlks::Selection& selection,
                const dlks::Evaluation& vector_result) {
  const dlks::Program program = dlks::compile(expression, batch, registry);
  const dlks::Evaluation scalar_result =
      dlks::ScalarEngine(batch).evaluate(program, selection);
  REQUIRE_MATCH(scalar_result, vector_result);
}

dlks::Batch four_row_batch() {
  dlks::Batch batch;
  batch.add("i", testhelp::column(testhelp::int_values(
                     {dlks::Value(0), dlks::Value(1), dlks::Value(2), dlks::Value(3)})));
  batch.add("flag", testhelp::column(testhelp::bool_values(
                        {dlks::Value(false), dlks::Value(true), dlks::Value{}, dlks::Value(false)})));
  return batch;
}

}  // namespace

TEST(three_valued_logic_truth_tables) {
  dlks::Batch batch;
  batch.add("one", testhelp::column(testhelp::int_values({dlks::Value(1)})));
  dlks::Registry registry;
  const dlks::Selection selection{0};
  const int states[] = {-1, 0, 1};

  for (const dlks::Op op : {dlks::Op::And, dlks::Op::Or}) {
    for (const int lhs : states) {
      for (const int rhs : states) {
        const dlks::ExprPtr expression =
            dlks::Expr::binary(op, three_value(lhs), three_value(rhs));
        const dlks::Program program = dlks::compile(expression, batch, registry);
        const dlks::Evaluation result =
            dlks::VectorEngine(batch).evaluate(program, selection);
        CHECK(result.ok());
        if (result.values.value(0) != expected_logic(op, lhs, rhs)) {
          testfw::fail(__FILE__, __LINE__,
                       std::string(op_symbol(op)) + "(" + state_name(lhs) + ", " +
                           state_name(rhs) + ") = " + result.values.value(0).repr() +
                           ", expected " + expected_logic(op, lhs, rhs).repr());
        }
        check_both(batch, registry, expression, selection, result);
      }
    }
  }

  for (const int state : states) {
    const dlks::ExprPtr expression = dlks::Expr::unary(dlks::Op::Not, three_value(state));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    const dlks::Value expected =
        state < 0 ? dlks::Value{} : dlks::Value(state == 0);
    CHECK_EQ(result.values.value(0), expected);
    CHECK(result.ok());
    check_both(batch, registry, expression, selection, result);
  }
}

TEST(and_or_short_circuit_skips_dangerous_rows) {
  const dlks::Batch batch = four_row_batch();
  const dlks::Selection selection = dlks::all_rows(4);

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr expression = dlks::Expr::binary(
        dlks::Op::And, dlks::Expr::column("flag"),
        dlks::Expr::binary(dlks::Op::Gt,
                           dlks::Expr::call("danger", {dlks::Expr::column("i")}),
                           dlks::Expr::literal(dlks::Value(0))));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(stats->calls["danger"], std::uint64_t(2));
    CHECK_EQ(result.values.describe(), std::string("bool[false, true, null, false]"));
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK_EQ(result.errors[2].node_id,
             testhelp::node_id_matching(program, "call 'danger'"));
    CHECK(result.errors[2].message.find("danger at 2") != std::string::npos);
    check_both(batch, registry, expression, selection, result);
  }

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr danger = dlks::Expr::binary(
        dlks::Op::Gt, dlks::Expr::call("danger", {dlks::Expr::column("i")}),
        dlks::Expr::literal(dlks::Value(0)));

    const dlks::ExprPtr false_and = dlks::Expr::binary(
        dlks::Op::And, dlks::Expr::literal(dlks::Value(false)), danger);
    const dlks::Program program = dlks::compile(false_and, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(stats->calls["danger"], std::uint64_t(0));
    CHECK_EQ(result.values.describe(),
             std::string("bool[false, false, false, false]"));
    CHECK(result.ok());
    check_both(batch, registry, false_and, selection, result);
  }

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr danger = dlks::Expr::binary(
        dlks::Op::Gt, dlks::Expr::call("danger", {dlks::Expr::column("i")}),
        dlks::Expr::literal(dlks::Value(0)));
    const dlks::ExprPtr true_or =
        dlks::Expr::binary(dlks::Op::Or, dlks::Expr::literal(dlks::Value(true)), danger);
    const dlks::Program program = dlks::compile(true_or, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(stats->calls["danger"], std::uint64_t(0));
    CHECK_EQ(result.values.describe(), std::string("bool[true, true, true, true]"));
    CHECK(result.ok());
    check_both(batch, registry, true_or, selection, result);
  }

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr danger = dlks::Expr::binary(
        dlks::Op::Gt, dlks::Expr::call("danger", {dlks::Expr::column("i")}),
        dlks::Expr::literal(dlks::Value(0)));
    const dlks::ExprPtr null_or =
        dlks::Expr::binary(dlks::Op::Or, dlks::Expr::literal(dlks::Value{}), danger);
    const dlks::Program program = dlks::compile(null_or, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(stats->calls["danger"], std::uint64_t(4));
    CHECK_EQ(result.values.describe(),
             std::string("bool[null, true, null, true]"));
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK(!result.errors[2].ok());
    check_both(batch, registry, null_or, selection, result);
  }
}

TEST(if_and_coalesce_are_lazy) {
  const dlks::Batch batch = four_row_batch();
  const dlks::Selection selection = dlks::all_rows(4);

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr expression = dlks::Expr::if_then_else(
        dlks::Expr::column("flag"),
        dlks::Expr::call("thenf", {dlks::Expr::column("i")}),
        dlks::Expr::call("elsef", {dlks::Expr::column("i")}));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("int64[-100, 101, null, -97]"));
    CHECK(result.ok());
    CHECK_EQ(stats->calls["thenf"], std::uint64_t(1));
    CHECK_EQ(stats->calls["elsef"], std::uint64_t(2));
    check_both(batch, registry, expression, selection, result);
  }

  {
    dlks::Batch coalesce_batch;
    coalesce_batch.add(
        "a", testhelp::column(testhelp::int_values(
                 {dlks::Value{}, dlks::Value(5), dlks::Value{}, dlks::Value(8)})));
    coalesce_batch.add("i", testhelp::column(testhelp::int_values(
                                {dlks::Value(0), dlks::Value(1), dlks::Value(2),
                                 dlks::Value(3)})));
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr expression = dlks::Expr::coalesce(
        dlks::Expr::column("a"), dlks::Expr::call("side", {dlks::Expr::column("i")}));
    const dlks::Program program = dlks::compile(expression, coalesce_batch, registry);
    const dlks::Evaluation result =
        dlks::VectorEngine(coalesce_batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("int64[0, 5, 2, 8]"));
    CHECK(result.ok());
    CHECK_EQ(stats->calls["side"], std::uint64_t(2));
    check_both(coalesce_batch, registry, expression, selection, result);
  }

  {
    dlks::Batch coalesce_batch;
    coalesce_batch.add(
        "a", testhelp::column(testhelp::int_values(
                 {dlks::Value{}, dlks::Value(5), dlks::Value{}, dlks::Value(8)})));
    coalesce_batch.add("i", testhelp::column(testhelp::int_values(
                                {dlks::Value(0), dlks::Value(1), dlks::Value(2),
                                 dlks::Value(3)})));
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr expression = dlks::Expr::coalesce(
        dlks::Expr::column("a"),
        dlks::Expr::call("side_boom", {dlks::Expr::column("i")}));
    const dlks::Program program = dlks::compile(expression, coalesce_batch, registry);
    const dlks::Evaluation result =
        dlks::VectorEngine(coalesce_batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("int64[0, 5, null, 8]"));
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK_EQ(result.errors[2].node_id,
             testhelp::node_id_matching(program, "call 'side_boom'"));
    CHECK_EQ(stats->calls["side_boom"], std::uint64_t(2));
    check_both(coalesce_batch, registry, expression, selection, result);
  }
}

TEST(division_errors_respect_short_circuit) {
  dlks::Batch batch;
  batch.add("one", testhelp::column(testhelp::int_values(
                       {dlks::Value(1), dlks::Value(1), dlks::Value(1)})));
  batch.add("zero", testhelp::column(testhelp::int_values(
                        {dlks::Value(0), dlks::Value(0), dlks::Value(0)})));
  const dlks::Selection selection = dlks::all_rows(3);
  dlks::Registry registry;

  const dlks::ExprPtr division = dlks::Expr::binary(
      dlks::Op::Div, dlks::Expr::column("one"), dlks::Expr::column("zero"));
  const dlks::ExprPtr comparison =
      dlks::Expr::binary(dlks::Op::Gt, division, dlks::Expr::literal(dlks::Value(0)));
  const dlks::ExprPtr false_and = dlks::Expr::binary(
      dlks::Op::And, dlks::Expr::literal(dlks::Value(false)), comparison);
  const dlks::ExprPtr true_or = dlks::Expr::binary(
      dlks::Op::Or, dlks::Expr::literal(dlks::Value(true)), comparison);
  const dlks::ExprPtr true_and = dlks::Expr::binary(
      dlks::Op::And, dlks::Expr::literal(dlks::Value(true)), comparison);
  const dlks::ExprPtr null_or = dlks::Expr::binary(
      dlks::Op::Or, dlks::Expr::literal(dlks::Value{}), comparison);

  {
    const dlks::Program program = dlks::compile(false_and, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("bool[false, false, false]"));
    CHECK(result.ok());
    check_both(batch, registry, false_and, selection, result);
  }
  {
    const dlks::Program program = dlks::compile(true_or, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("bool[true, true, true]"));
    CHECK(result.ok());
    check_both(batch, registry, true_or, selection, result);
  }
  {
    const dlks::Program program = dlks::compile(true_and, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(3));
    const std::uint32_t division_id =
        testhelp::node_id_matching(program, "div");
    for (std::size_t i = 0; i < 3; ++i) {
      CHECK_EQ(result.errors[i].node_id, division_id);
      CHECK_EQ(result.errors[i].message, std::string("division by zero"));
    }
    check_both(batch, registry, true_and, selection, result);
  }
  {
    const dlks::Program program = dlks::compile(null_or, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(3));
    check_both(batch, registry, null_or, selection, result);
  }
}

TEST(error_position_is_first_in_selection_order) {
  dlks::Batch batch;
  batch.add("a", testhelp::column(testhelp::int_values({dlks::Value(10), dlks::Value(10)})));
  batch.add("b", testhelp::column(testhelp::int_values({dlks::Value(1), dlks::Value(0)})));
  batch.add("c", testhelp::column(testhelp::int_values({dlks::Value(10), dlks::Value(10)})));
  batch.add("d", testhelp::column(testhelp::int_values({dlks::Value(0), dlks::Value(1)})));
  dlks::Registry registry;

  const dlks::ExprPtr expression = dlks::Expr::binary(
      dlks::Op::Add,
      dlks::Expr::binary(dlks::Op::Div, dlks::Expr::column("a"),
                         dlks::Expr::column("b")),
      dlks::Expr::binary(dlks::Op::Div, dlks::Expr::column("c"),
                         dlks::Expr::column("d")));
  const dlks::Program program = dlks::compile(expression, batch, registry);

  std::vector<std::uint32_t> division_ids;
  for (const dlks::Expr* node : program.nodes) {
    if (node->kind() == dlks::Expr::Kind::Binary && node->op() == dlks::Op::Div) {
      division_ids.push_back(program.node_id(*node));
    }
  }
  CHECK_EQ(division_ids.size(), std::size_t(2));

  {
    const dlks::Selection selection{0, 1};
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.first_error_position().value(), std::size_t(0));
    CHECK_EQ(result.errors[0].node_id, division_ids[1]);
    CHECK_EQ(result.errors[1].node_id, division_ids[0]);
    const dlks::Evaluation scalar =
        dlks::ScalarEngine(batch).evaluate(program, selection);
    REQUIRE_MATCH(scalar, result);
  }
  {
    const dlks::Selection selection{1, 0};
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.errors[0].node_id, division_ids[0]);
    CHECK_EQ(result.errors[1].node_id, division_ids[1]);
    const dlks::Evaluation scalar =
        dlks::ScalarEngine(batch).evaluate(program, selection);
    REQUIRE_MATCH(scalar, result);
  }

  const dlks::ExprPtr left_division = dlks::Expr::binary(
      dlks::Op::Div, dlks::Expr::column("a"), dlks::Expr::column("b"));
  const dlks::Program division_program = dlks::compile(left_division, batch, registry);
  const std::uint32_t left_id =
      testhelp::node_id_matching(division_program, "div");
  const dlks::Selection reversed{1, 0};
  bool caught = false;
  try {
    (void)dlks::VectorEngine(batch).evaluate_or_throw(division_program, reversed);
  } catch (const dlks::EvalError& error) {
    caught = true;
    CHECK_EQ(error.position(), std::size_t(0));
    CHECK_EQ(error.row(), std::uint32_t(1));
    CHECK_EQ(error.node_id(), left_id);
    CHECK_EQ(error.detail(), std::string("division by zero"));
  }
  CHECK(caught);

  caught = false;
  try {
    (void)dlks::ScalarEngine(batch).evaluate_or_throw(division_program, reversed);
  } catch (const dlks::EvalError& error) {
    caught = true;
    CHECK_EQ(error.position(), std::size_t(0));
    CHECK_EQ(error.row(), std::uint32_t(1));
    CHECK_EQ(error.node_id(), left_id);
  }
  CHECK(caught);
}

TEST(null_propagation_and_is_null) {
  dlks::Batch batch;
  batch.add("i", testhelp::column(
                     testhelp::int_values({dlks::Value(1), dlks::Value{}, dlks::Value(3)})));
  batch.add("one", testhelp::column(
                       testhelp::int_values({dlks::Value(1), dlks::Value(1), dlks::Value(1)})));
  batch.add("zero", testhelp::column(
                        testhelp::int_values({dlks::Value(0), dlks::Value(0), dlks::Value(0)})));
  dlks::Registry registry;
  const dlks::Selection selection = dlks::all_rows(3);

  const dlks::ExprPtr comparisons[] = {
      dlks::Expr::binary(dlks::Op::Eq, dlks::Expr::column("i"),
                         dlks::Expr::literal(dlks::Value{})),
      dlks::Expr::binary(dlks::Op::Add, dlks::Expr::column("i"),
                         dlks::Expr::literal(dlks::Value{})),
      dlks::Expr::coalesce(dlks::Expr::column("i"), dlks::Expr::literal(dlks::Value(-1)))};
  const char* expected[] = {"bool[null, null, null]", "int64[null, null, null]",
                            "int64[1, -1, 3]"};
  for (std::size_t i = 0; i < 3; ++i) {
    const dlks::Program program = dlks::compile(comparisons[i], batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string(expected[i]));
    CHECK(result.ok());
    check_both(batch, registry, comparisons[i], selection, result);
  }

  const dlks::ExprPtr is_null = dlks::Expr::is_null(dlks::Expr::column("i"));
  {
    const dlks::Program program = dlks::compile(is_null, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("bool[false, true, false]"));
    CHECK(result.ok());
    check_both(batch, registry, is_null, selection, result);
  }

  const dlks::ExprPtr is_null_error = dlks::Expr::is_null(dlks::Expr::binary(
      dlks::Op::Div, dlks::Expr::column("one"), dlks::Expr::column("zero")));
  {
    const dlks::Program program = dlks::compile(is_null_error, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(3));
    CHECK_EQ(result.errors[0].message, std::string("division by zero"));
    check_both(batch, registry, is_null_error, selection, result);
  }
}

TEST(casts_and_local_cast_failures) {
  dlks::Batch batch;
  batch.add("s", testhelp::column(testhelp::string_values(
                     {dlks::Value("42"), dlks::Value{}, dlks::Value("abc"),
                      dlks::Value("-7")})));
  batch.add("d", testhelp::column(testhelp::double_values(
                     {dlks::Value(2.9), dlks::Value{}, dlks::Value(1e300),
                      dlks::Value(-0.9)})));
  batch.add("b", testhelp::column(testhelp::bool_values(
                     {dlks::Value(true), dlks::Value{}, dlks::Value(false),
                      dlks::Value(true)})));
  batch.add("i", testhelp::column(testhelp::int_values(
                     {dlks::Value(0), dlks::Value(2), dlks::Value(-1), dlks::Value{}})));
  const dlks::Selection selection = dlks::all_rows(4);
  dlks::Registry registry;

  {
    const dlks::ExprPtr expression =
        dlks::Expr::cast_to(dlks::Expr::column("s"), dlks::Type::Int64);
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("int64[42, null, null, -7]"));
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK(result.errors[2].message.find("invalid int64 literal") != std::string::npos);
    check_both(batch, registry, expression, selection, result);
  }
  {
    const dlks::ExprPtr expression =
        dlks::Expr::cast_to(dlks::Expr::column("d"), dlks::Type::Int64);
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("int64[2, null, null, 0]"));
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK(result.errors[2].message.find("out of int64 range") != std::string::npos);
    check_both(batch, registry, expression, selection, result);
  }
  {
    const dlks::ExprPtr expression =
        dlks::Expr::cast_to(dlks::Expr::column("b"), dlks::Type::String);
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(),
             std::string("string[\"true\", null, \"false\", \"true\"]"));
    CHECK(result.ok());
    check_both(batch, registry, expression, selection, result);
  }
  {
    const dlks::ExprPtr expression =
        dlks::Expr::cast_to(dlks::Expr::column("i"), dlks::Type::Bool);
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("bool[false, true, true, null]"));
    CHECK(result.ok());
    check_both(batch, registry, expression, selection, result);
  }
}

TEST(overflow_and_arithmetic_error_positions) {
  const std::int64_t maximum = std::numeric_limits<std::int64_t>::max();
  const std::int64_t minimum = std::numeric_limits<std::int64_t>::min();
  dlks::Batch batch;
  batch.add("x", testhelp::column(testhelp::int_values(
                     {dlks::Value(maximum), dlks::Value(minimum),
                      dlks::Value(minimum + 1)})));
  batch.add("one", testhelp::column(testhelp::int_values(
                       {dlks::Value(1), dlks::Value(1), dlks::Value(1)})));
  batch.add("minus_one", testhelp::column(testhelp::int_values(
                             {dlks::Value(-1), dlks::Value(-1), dlks::Value(-1)})));
  const dlks::Selection selection = dlks::all_rows(3);
  dlks::Registry registry;

  {
    const dlks::ExprPtr expression = dlks::Expr::binary(
        dlks::Op::Add, dlks::Expr::column("x"), dlks::Expr::column("one"));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK_EQ(result.errors[0].message, std::string("integer overflow in '+'"));
    CHECK_EQ(result.values.value(1), dlks::Value(minimum + 1));
    check_both(batch, registry, expression, selection, result);
  }
  {
    const dlks::ExprPtr expression =
        dlks::Expr::unary(dlks::Op::Neg, dlks::Expr::column("x"));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK(!result.errors[1].ok());
    CHECK_EQ(result.errors[1].message, std::string("integer overflow in '-'"));
    check_both(batch, registry, expression, selection, result);
  }
  {
    const dlks::ExprPtr expression = dlks::Expr::binary(
        dlks::Op::Div, dlks::Expr::column("x"), dlks::Expr::column("minus_one"));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK(!result.errors[1].ok());
    CHECK_EQ(result.errors[1].message, std::string("integer overflow in '/'"));
    check_both(batch, registry, expression, selection, result);
  }
  {
    const dlks::ExprPtr expression = dlks::Expr::binary(
        dlks::Op::Mod, dlks::Expr::column("x"), dlks::Expr::column("minus_one"));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK(result.ok());
    CHECK_EQ(result.values.value(1), dlks::Value(std::int64_t{0}));
    check_both(batch, registry, expression, selection, result);
  }
}

TEST(compile_time_type_errors) {
  dlks::Batch batch;
  batch.add("i", testhelp::column(testhelp::int_values({dlks::Value(1)})));
  batch.add("d", testhelp::column(testhelp::double_values({dlks::Value(1.5)})));
  batch.add("b", testhelp::column(testhelp::bool_values({dlks::Value(true)})));
  batch.add("s", testhelp::column(testhelp::string_values({dlks::Value("x")})));
  dlks::Registry registry;
  registry.add({"f", {dlks::Type::Int64}, dlks::Type::Int64,
                [](const std::vector<dlks::Value>& arguments) { return arguments[0]; }});

  CHECK_THROWS_AS(dlks::compile(dlks::Expr::column("missing"), batch, registry),
                  dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::binary(dlks::Op::And, dlks::Expr::column("i"),
                                       dlks::Expr::column("b")),
                    batch, registry),
      dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::binary(dlks::Op::Add, dlks::Expr::column("b"),
                                       dlks::Expr::column("i")),
                    batch, registry),
      dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::binary(dlks::Op::Mod, dlks::Expr::column("d"),
                                       dlks::Expr::column("i")),
                    batch, registry),
      dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::cast_to(dlks::Expr::column("b"), dlks::Type::Null),
                    batch, registry),
      dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::call("nope", {dlks::Expr::column("i")}), batch,
                    registry),
      dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::call("f", {dlks::Expr::column("i"),
                                           dlks::Expr::column("i")}),
                    batch, registry),
      dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::call("f", {dlks::Expr::column("s")}), batch,
                    registry),
      dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::if_then_else(dlks::Expr::column("i"),
                                             dlks::Expr::column("i"),
                                             dlks::Expr::column("i")),
                    batch, registry),
      dlks::CompileError);
  CHECK_THROWS_AS(
      dlks::compile(dlks::Expr::coalesce(dlks::Expr::column("i"),
                                         dlks::Expr::column("s")),
                    batch, registry),
      dlks::CompileError);
  CHECK_THROWS_AS(dlks::Expr::binary(dlks::Op::Add, nullptr, dlks::Expr::column("i")),
                  std::invalid_argument);
}

TEST(dictionary_columns_are_lazy_under_short_circuit) {
  const auto build = [](std::shared_ptr<int> calls) {
    dlks::Batch batch;
    batch.add("flag", testhelp::column(testhelp::bool_values(
                          {dlks::Value(false), dlks::Value(true), dlks::Value(false),
                           dlks::Value(true)})));
    batch.add("dict", dlks::make_dictionary_column(
                          dlks::Type::String, {0, 1, 2, 3},
                          [calls](std::uint32_t code) -> dlks::Value {
                            ++*calls;
                            return dlks::Value(std::to_string(code));
                          },
                          "dict"));
    return batch;
  };

  const dlks::ExprPtr expression = dlks::Expr::binary(
      dlks::Op::And, dlks::Expr::column("flag"),
      dlks::Expr::binary(dlks::Op::Eq, dlks::Expr::column("dict"),
                         dlks::Expr::literal(dlks::Value("2"))));
  const dlks::Selection selection = dlks::all_rows(4);
  dlks::Registry registry;

  {
    const auto calls = std::make_shared<int>(0);
    dlks::Batch batch = build(calls);
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result =
        dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(*calls, 2);
    CHECK_EQ(result.values.describe(),
             std::string("bool[false, false, false, false]"));
    CHECK(result.ok());
    const auto* dictionary =
        dynamic_cast<const dlks::DictionaryColumn*>(batch.find("dict"));
    CHECK(dictionary != nullptr);
    CHECK(dictionary->touched_codes() == (std::vector<std::uint32_t>{1, 3}));
  }
  {
    const auto calls = std::make_shared<int>(0);
    dlks::Batch batch = build(calls);
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result =
        dlks::ScalarEngine(batch).evaluate(program, selection);
    CHECK_EQ(*calls, 2);
    CHECK_EQ(result.values.describe(),
             std::string("bool[false, false, false, false]"));
    CHECK(result.ok());
  }
  {
    const auto calls = std::make_shared<int>(0);
    dlks::Batch batch = build(calls);
    const dlks::ExprPtr always_false = dlks::Expr::binary(
        dlks::Op::And, dlks::Expr::literal(dlks::Value(false)),
        dlks::Expr::binary(dlks::Op::Eq, dlks::Expr::column("dict"),
                           dlks::Expr::literal(dlks::Value("0"))));
    const dlks::Program program = dlks::compile(always_false, batch, registry);
    const dlks::Evaluation result =
        dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(*calls, 0);
    CHECK(result.ok());
  }
  {
    const auto calls = std::make_shared<int>(0);
    dlks::Batch batch = build(calls);
    const dlks::ExprPtr coalesced = dlks::Expr::coalesce(
        dlks::Expr::literal(dlks::Value("x")), dlks::Expr::column("dict"));
    const dlks::Program program = dlks::compile(coalesced, batch, registry);
    const dlks::Evaluation result =
        dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(*calls, 0);
    CHECK_EQ(result.values.describe(),
             std::string("string[\"x\", \"x\", \"x\", \"x\"]"));
    CHECK(result.ok());
  }
}

TEST(dictionary_failure_is_a_row_error) {
  dlks::Batch batch;
  batch.add("dict", dlks::make_dictionary_column(
                        dlks::Type::String, {1, 1, 0},
                        [](std::uint32_t code) -> dlks::Value {
                          if (code == 1) {
                            throw std::runtime_error("provider failed");
                          }
                          return dlks::Value("ok");
                        },
                        "dict"));
  dlks::Registry registry;
  const dlks::ExprPtr expression = dlks::Expr::binary(
      dlks::Op::Eq, dlks::Expr::column("dict"), dlks::Expr::literal(dlks::Value("ok")));
  const dlks::Program program = dlks::compile(expression, batch, registry);
  const dlks::Selection selection = dlks::all_rows(3);
  const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
  CHECK_EQ(result.error_count(), std::size_t(2));
  CHECK_EQ(result.values.value(2), dlks::Value(true));
  CHECK_EQ(result.errors[0].node_id,
           testhelp::node_id_matching(program, "column 'dict'"));
  CHECK(result.errors[0].message.find("provider failed") != std::string::npos);
  const dlks::Evaluation scalar = dlks::ScalarEngine(batch).evaluate(program, selection);
  REQUIRE_MATCH(scalar, result);
}

TEST(duplicate_and_reordered_selections_keep_alignment) {
  dlks::Batch batch;
  batch.add("i", testhelp::column(testhelp::int_values(
                     {dlks::Value(10), dlks::Value(20), dlks::Value(30)})));
  dlks::Registry registry;
  const dlks::ExprPtr expression = dlks::Expr::binary(
      dlks::Op::Add, dlks::Expr::column("i"), dlks::Expr::literal(dlks::Value(1)));
  const dlks::Program program = dlks::compile(expression, batch, registry);
  const dlks::Selection selection{2, 2, 0, 1};
  const dlks::Evaluation vector_result =
      dlks::VectorEngine(batch).evaluate(program, selection);
  CHECK_EQ(vector_result.values.describe(), std::string("int64[31, 31, 11, 21]"));
  const dlks::Evaluation scalar_result =
      dlks::ScalarEngine(batch).evaluate(program, selection);
  REQUIRE_MATCH(scalar_result, vector_result);
}

TEST(functions_are_null_strict_and_arguments_short_circuit) {
  dlks::Batch batch;
  batch.add("i", testhelp::column(testhelp::int_values(
                     {dlks::Value(0), dlks::Value(1), dlks::Value(2), dlks::Value(3)})));
  batch.add("one", testhelp::column(testhelp::int_values(
                       {dlks::Value(1), dlks::Value(1), dlks::Value(1), dlks::Value(1)})));
  batch.add("zero", testhelp::column(testhelp::int_values(
                        {dlks::Value(0), dlks::Value(0), dlks::Value(0), dlks::Value(0)})));
  const dlks::Selection selection = dlks::all_rows(4);

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr expression =
        dlks::Expr::call("side", {dlks::Expr::literal(dlks::Value{})});
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(0));
    CHECK_EQ(result.values.describe(), std::string("int64[null, null, null, null]"));
    CHECK_EQ(stats->calls.count("side"), std::size_t(0));
    check_both(batch, registry, expression, selection, result);
  }

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr division = dlks::Expr::binary(
        dlks::Op::Div, dlks::Expr::column("one"), dlks::Expr::column("zero"));
    const dlks::ExprPtr expression =
        dlks::Expr::call("side", {division});
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(4));
    CHECK_EQ(result.errors[0].node_id, testhelp::node_id_matching(program, "div"));
    CHECK_EQ(stats->calls.count("side"), std::size_t(0));
    check_both(batch, registry, expression, selection, result);
  }

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr division = dlks::Expr::binary(
        dlks::Op::Div, dlks::Expr::column("one"), dlks::Expr::column("zero"));
    const dlks::ExprPtr expression = dlks::Expr::call(
        "combine", {division, dlks::Expr::call("danger", {dlks::Expr::column("i")})});
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(4));
    CHECK_EQ(stats->calls.count("danger"), std::size_t(0));
    CHECK_EQ(stats->calls.count("combine"), std::size_t(0));
    check_both(batch, registry, expression, selection, result);
  }

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr expression = dlks::Expr::call(
        "combine", {dlks::Expr::literal(dlks::Value{}),
                    dlks::Expr::call("danger", {dlks::Expr::column("i")})});
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(stats->calls["danger"], std::uint64_t(4));
    CHECK_EQ(stats->calls.count("combine"), std::size_t(0));
    CHECK_EQ(result.error_count(), std::size_t(1));
    CHECK_EQ(result.errors[2].node_id,
             testhelp::node_id_matching(program, "call 'danger'"));
    CHECK_EQ(result.values.describe(), std::string("int64[null, null, null, null]"));
    check_both(batch, registry, expression, selection, result);
  }
}

TEST(selection_bounds_are_checked) {
  dlks::Batch batch;
  batch.add("i", testhelp::column(testhelp::int_values({dlks::Value(1), dlks::Value(2)})));
  dlks::Registry registry;
  const dlks::ExprPtr expression = dlks::Expr::column("i");
  const dlks::Program program = dlks::compile(expression, batch, registry);
  CHECK_THROWS_AS(dlks::VectorEngine(batch).evaluate(program, dlks::Selection{2}),
                  std::out_of_range);
  CHECK_THROWS_AS(dlks::ScalarEngine(batch).evaluate(program, dlks::Selection{2}),
                  std::out_of_range);
}

TEST(if_and_coalesce_promote_mixed_numeric_branches) {
  dlks::Batch batch;
  batch.add("b", testhelp::column(testhelp::bool_values(
                     {dlks::Value(true), dlks::Value(false), dlks::Value{}})));
  batch.add("i", testhelp::column(
                     testhelp::int_values({dlks::Value(1), dlks::Value(2), dlks::Value{}})));
  dlks::Registry registry;
  const dlks::Selection selection = dlks::all_rows(3);

  {
    const dlks::ExprPtr expression = dlks::Expr::if_then_else(
        dlks::Expr::column("b"), dlks::Expr::column("i"),
        dlks::Expr::literal(dlks::Value(2.5)));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    CHECK_EQ(program.result_type, dlks::Type::Double);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("double[1, 2.5, null]"));
    CHECK(result.ok());
    check_both(batch, registry, expression, selection, result);
  }
  {
    const dlks::ExprPtr expression = dlks::Expr::coalesce(
        dlks::Expr::column("i"), dlks::Expr::literal(dlks::Value(0.5)));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    CHECK_EQ(program.result_type, dlks::Type::Double);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("double[1, 2, 0.5]"));
    CHECK(result.ok());
    check_both(batch, registry, expression, selection, result);
  }
  {
    const dlks::ExprPtr expression = dlks::Expr::coalesce(
        dlks::Expr::cast_to(dlks::Expr::column("i"), dlks::Type::Double),
        dlks::Expr::literal(dlks::Value(3)));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    CHECK_EQ(program.result_type, dlks::Type::Double);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.values.describe(), std::string("double[1, 2, 3]"));
    CHECK(result.ok());
    check_both(batch, registry, expression, selection, result);
  }
}

TEST(left_error_short_circuits_right_and_null_condition_skips_branches) {
  dlks::Batch batch;
  batch.add("i", testhelp::column(testhelp::int_values(
                     {dlks::Value(0), dlks::Value(1), dlks::Value(2), dlks::Value(3)})));
  batch.add("flag", testhelp::column(testhelp::bool_values(
                        {dlks::Value(false), dlks::Value(true), dlks::Value{},
                         dlks::Value(false)})));
  batch.add("one", testhelp::column(testhelp::int_values(
                       {dlks::Value(1), dlks::Value(1), dlks::Value(1), dlks::Value(1)})));
  batch.add("zero", testhelp::column(testhelp::int_values(
                        {dlks::Value(0), dlks::Value(0), dlks::Value(0), dlks::Value(0)})));
  const dlks::Selection selection = dlks::all_rows(4);

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr division = dlks::Expr::binary(
        dlks::Op::Div, dlks::Expr::column("one"), dlks::Expr::column("zero"));
    const dlks::ExprPtr expression = dlks::Expr::binary(
        dlks::Op::Add, division,
        dlks::Expr::call("side", {dlks::Expr::column("i")}));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(4));
    CHECK_EQ(stats->calls.count("side"), std::size_t(0));
    CHECK_EQ(result.errors[0].node_id, testhelp::node_id_matching(program, "div"));
    check_both(batch, registry, expression, selection, result);
  }

  {
    const auto stats = make_stats();
    const dlks::Registry registry = make_danger_registry(stats);
    const dlks::ExprPtr division = dlks::Expr::binary(
        dlks::Op::Div, dlks::Expr::column("one"), dlks::Expr::column("zero"));
    const dlks::ExprPtr expression =
        dlks::Expr::coalesce(division, dlks::Expr::literal(dlks::Value(5)));
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(4));
    CHECK_EQ(result.errors[0].node_id, testhelp::node_id_matching(program, "div"));
    check_both(batch, registry, expression, selection, result);
  }

  {
    const dlks::Registry registry;
    const dlks::ExprPtr division = dlks::Expr::binary(
        dlks::Op::Div, dlks::Expr::column("one"), dlks::Expr::column("zero"));
    const dlks::ExprPtr expression = dlks::Expr::if_then_else(
        dlks::Expr::column("flag"), division, division);
    const dlks::Program program = dlks::compile(expression, batch, registry);
    const dlks::Evaluation result = dlks::VectorEngine(batch).evaluate(program, selection);
    CHECK_EQ(result.error_count(), std::size_t(3));
    CHECK(result.errors[2].ok());
    CHECK(result.values.is_null(2));
    CHECK(result.values.is_null(0));
    check_both(batch, registry, expression, selection, result);
  }
}

TEST(program_is_self_contained_after_registry_destruction) {
  dlks::Batch batch;
  batch.add("i", testhelp::column(testhelp::int_values(
                     {dlks::Value(1), dlks::Value(2), dlks::Value(3)})));
  dlks::ExprPtr expression;
  dlks::Program program;
  {
    dlks::Registry registry;
    registry.add({"double_i", {dlks::Type::Int64}, dlks::Type::Int64,
                  [](const std::vector<dlks::Value>& arguments) {
                    return dlks::Value(arguments[0].as_i64() * 2);
                  }});
    expression = dlks::Expr::call("double_i", {dlks::Expr::column("i")});
    program = dlks::compile(expression, batch, registry);
  }
  const dlks::Evaluation result =
      dlks::VectorEngine(batch).evaluate(program, dlks::all_rows(3));
  CHECK_EQ(result.values.describe(), std::string("int64[2, 4, 6]"));
  CHECK(result.ok());
  const dlks::Evaluation scalar =
      dlks::ScalarEngine(batch).evaluate(program, dlks::all_rows(3));
  REQUIRE_MATCH(scalar, result);
}
