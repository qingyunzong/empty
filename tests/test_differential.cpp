#include "test_helpers.hpp"

#include <cstdint>
#include <memory>
#include <random>
#include <sstream>
#include <string>
#include <vector>

namespace {

std::string describe_selection(const dlks::Selection& selection) {
  std::ostringstream out;
  out << "size=" << selection.size() << " [";
  const std::size_t limit = std::min<std::size_t>(selection.size(), 8);
  for (std::size_t i = 0; i < limit; ++i) {
    if (i != 0) {
      out << ", ";
    }
    out << selection[i];
  }
  if (selection.size() > limit) {
    out << ", ...";
  }
  out << "]";
  return out.str();
}

}  // namespace

TEST(differential_randomized_batches) {
  const std::size_t seeds = testfw::options().differential_seeds;
  const std::uint64_t base = testfw::options().seed_base;
  const dlks::Type targets[] = {dlks::Type::Int64, dlks::Type::Double, dlks::Type::Bool,
                                dlks::Type::String};
  std::size_t seeds_with_errors = 0;
  std::size_t seeds_with_nulls = 0;
  std::size_t seeds_with_calls = 0;
  std::size_t seeds_with_dictionary_failures = 0;

  for (std::size_t index = 0; index < seeds; ++index) {
    const std::uint64_t seed = base + index;
    std::mt19937_64 rng(seed);
    const std::size_t rows = 1 + static_cast<std::size_t>(rng() % 24);
    const dlks::DatasetSpec spec = dlks::random_dataset(rng, rows);

    const auto scalar_counters = std::make_shared<dlks::CallCounters>();
    const auto vector_counters = std::make_shared<dlks::CallCounters>();
    const dlks::Registry scalar_registry = dlks::make_test_registry(scalar_counters);
    const dlks::Registry vector_registry = dlks::make_test_registry(vector_counters);
    dlks::Batch scalar_batch = dlks::make_batch(spec);
    dlks::Batch vector_batch = dlks::make_batch(spec);

    const dlks::Type target = targets[rng() % 4];
    dlks::RandomExprGenerator generator(rng, scalar_registry, 4);
    const dlks::ExprPtr expression = generator.make(target);

    const dlks::Program scalar_program =
        dlks::compile(expression, scalar_batch, scalar_registry);
    const dlks::Program vector_program =
        dlks::compile(expression, vector_batch, vector_registry);
    CHECK_EQ(scalar_program.result_type, vector_program.result_type);
    CHECK_EQ(scalar_program.nodes.size(), vector_program.nodes.size());

    const auto* scalar_dictionary =
        dynamic_cast<const dlks::DictionaryColumn*>(scalar_batch.find("dict"));
    const auto* vector_dictionary =
        dynamic_cast<const dlks::DictionaryColumn*>(vector_batch.find("dict"));
    CHECK(scalar_dictionary != nullptr);
    CHECK(vector_dictionary != nullptr);

    bool saw_error = false;
    bool saw_null = false;
    bool saw_dictionary_failure = false;
    for (const dlks::Selection& selection : dlks::random_selections(rng, rows)) {
      const dlks::Evaluation scalar_result =
          dlks::ScalarEngine(scalar_batch).evaluate(scalar_program, selection);
      const dlks::Evaluation vector_result =
          dlks::VectorEngine(vector_batch).evaluate(vector_program, selection);

      const auto report = [&](const dlks::Divergence& divergence) {
        std::ostringstream out;
        out << "seed=" << seed << " rows=" << rows
            << " target=" << dlks::type_name(target)
            << " selection=" << describe_selection(selection) << "\n  expr: "
            << dlks::to_string(*expression) << "\n  scalar: "
            << dlks::describe_evaluation(scalar_result) << "\n  vector: "
            << dlks::describe_evaluation(vector_result) << "\n  divergence "
            << divergence.area << ": " << divergence.detail;
        testfw::fail(__FILE__, __LINE__, out.str());
      };

      const auto evaluation_divergence =
          dlks::compare_evaluations(scalar_result, vector_result);
      if (evaluation_divergence.has_value()) {
        report(*evaluation_divergence);
      }
      if (!scalar_result.ok()) {
        saw_error = true;
      }
      for (std::size_t i = 0; i < scalar_result.values.size(); ++i) {
        if (scalar_result.values.is_null(i)) {
          saw_null = true;
        }
      }
      for (const dlks::ErrorInfo& error : scalar_result.errors) {
        if (error.message.find("materialization failed") != std::string::npos) {
          saw_dictionary_failure = true;
        }
      }

      const auto counter_divergence =
          dlks::compare_counters(scalar_counters->calls, vector_counters->calls);
      if (counter_divergence.has_value()) {
        report(*counter_divergence);
      }

      const auto code_divergence = dlks::compare_code_sets(
          scalar_dictionary->touched_codes(), vector_dictionary->touched_codes(), "dict");
      if (code_divergence.has_value()) {
        report(*code_divergence);
      }
      if (scalar_dictionary->materializations() != vector_dictionary->materializations()) {
        testfw::fail(__FILE__, __LINE__,
                     "dictionary materialization count differs for seed " +
                         std::to_string(seed));
      }
    }
    seeds_with_errors += saw_error ? 1 : 0;
    seeds_with_nulls += saw_null ? 1 : 0;
    seeds_with_dictionary_failures += saw_dictionary_failure ? 1 : 0;
    if (!scalar_counters->calls.empty()) {
      ++seeds_with_calls;
    }
  }

  // Coverage assertions are only meaningful for a reasonably large corpus;
  // small user-supplied runs must still be allowed to pass.
  if (seeds >= 100) {
    CHECK(seeds_with_errors > 0);
    CHECK(seeds_with_nulls > 0);
    CHECK(seeds_with_calls > 0);
    CHECK(seeds_with_dictionary_failures > 0);
  }
}

TEST(differential_empty_selection) {
  std::mt19937_64 rng(1234567);
  const dlks::DatasetSpec spec = dlks::random_dataset(rng, 12);
  dlks::Batch scalar_batch = dlks::make_batch(spec);
  dlks::Batch vector_batch = dlks::make_batch(spec);
  const dlks::Registry registry;
  const dlks::ExprPtr expression = dlks::Expr::binary(
      dlks::Op::Add, dlks::Expr::column("i"),
      dlks::Expr::cast_to(dlks::Expr::column("d"), dlks::Type::Int64));
  const dlks::Program scalar_program =
      dlks::compile(expression, scalar_batch, registry);
  const dlks::Program vector_program =
      dlks::compile(expression, vector_batch, registry);
  const dlks::Selection empty;
  const dlks::Evaluation scalar_result =
      dlks::ScalarEngine(scalar_batch).evaluate(scalar_program, empty);
  const dlks::Evaluation vector_result =
      dlks::VectorEngine(vector_batch).evaluate(vector_program, empty);
  CHECK_EQ(scalar_result.values.size(), std::size_t(0));
  CHECK_EQ(vector_result.values.size(), std::size_t(0));
  CHECK(scalar_result.ok());
  CHECK(vector_result.ok());
  REQUIRE_MATCH(scalar_result, vector_result);
  const auto* dictionary =
      dynamic_cast<const dlks::DictionaryColumn*>(vector_batch.find("dict"));
  CHECK(dictionary != nullptr);
  CHECK_EQ(dictionary->materializations(), std::size_t(0));
}

TEST(differential_all_null_columns) {
  dlks::Batch batch_a;
  dlks::Batch batch_b;
  for (dlks::Batch* batch : {&batch_a, &batch_b}) {
    batch->add("i", testhelp::column(
                         testhelp::int_values({dlks::Value{}, dlks::Value{}, dlks::Value{}})));
    batch->add("b", testhelp::column(
                         testhelp::bool_values({dlks::Value{}, dlks::Value{}, dlks::Value{}})));
    batch->add("s", testhelp::column(testhelp::string_values(
                         {dlks::Value{}, dlks::Value{}, dlks::Value{}})));
  }
  const dlks::Registry registry;
  const dlks::ExprPtr expression = dlks::Expr::if_then_else(
      dlks::Expr::column("b"),
      dlks::Expr::binary(dlks::Op::Add, dlks::Expr::column("i"),
                         dlks::Expr::literal(dlks::Value(1))),
      dlks::Expr::cast_to(dlks::Expr::column("s"), dlks::Type::Int64));
  const dlks::Program program_a = dlks::compile(expression, batch_a, registry);
  const dlks::Program program_b = dlks::compile(expression, batch_b, registry);
  const dlks::Selection selection = dlks::all_rows(3);
  const dlks::Evaluation scalar =
      dlks::ScalarEngine(batch_a).evaluate(program_a, selection);
  const dlks::Evaluation vector =
      dlks::VectorEngine(batch_b).evaluate(program_b, selection);
  CHECK_EQ(vector.values.describe(), std::string("int64[null, null, null]"));
  CHECK(vector.ok());
  REQUIRE_MATCH(scalar, vector);
}
