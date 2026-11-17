#include <iostream>
#include <memory>
#include <string>

#include "dlks_formal.hpp"

namespace {

dlks::ExprPtr col(std::string name) { return dlks::Expr::column(std::move(name)); }

dlks::ExprPtr lit(dlks::Value value) { return dlks::Expr::literal(std::move(value)); }

}  // namespace

int main() {
  dlks::Batch batch;
  batch.add("amount", std::make_shared<dlks::InMemoryColumn>(dlks::Vector::from_values(
                          dlks::Type::Int64,
                          {dlks::Value(4), dlks::Value(0), dlks::Value(25),
                           dlks::Value{}, dlks::Value(2)})));
  batch.add("active", std::make_shared<dlks::InMemoryColumn>(dlks::Vector::from_values(
                          dlks::Type::Bool,
                          {dlks::Value(true), dlks::Value(false), dlks::Value(true),
                           dlks::Value(true), dlks::Value(true)})));

  auto materializations = std::make_shared<int>(0);
  batch.add("region", dlks::make_dictionary_column(
                          dlks::Type::String, {0, 1, 2, 3, 4},
                          [materializations](std::uint32_t code) -> dlks::Value {
                            ++*materializations;
                            return dlks::Value("region-" + std::to_string(code));
                          },
                          "region"));

  dlks::Registry registry;
  const dlks::Selection selection = dlks::all_rows(batch.size());

  // `amount != 0 AND 100 / amount > 5`: division is only evaluated on rows
  // where amount is non-zero, so the zero row cannot raise division by zero.
  const dlks::ExprPtr guarded = dlks::Expr::binary(
      dlks::Op::And,
      dlks::Expr::binary(dlks::Op::Ne, col("amount"), lit(dlks::Value(0))),
      dlks::Expr::binary(dlks::Op::Gt,
                         dlks::Expr::binary(dlks::Op::Div, lit(dlks::Value(100)),
                                            col("amount")),
                         lit(dlks::Value(5))));
  const dlks::Program guarded_program = dlks::compile(guarded, batch, registry);
  const dlks::Evaluation guarded_result =
      dlks::VectorEngine(batch).evaluate(guarded_program, selection);
  std::cout << "guarded:      " << dlks::describe_evaluation(guarded_result) << "\n";

  const dlks::ExprPtr lazy_region = dlks::Expr::if_then_else(
      col("active"), col("region"), lit(dlks::Value("inactive")));
  const dlks::Program lazy_program = dlks::compile(lazy_region, batch, registry);
  const dlks::Evaluation lazy_result =
      dlks::VectorEngine(batch).evaluate(lazy_program, selection);
  std::cout << "lazy region:  " << dlks::describe_evaluation(lazy_result) << "\n";
  std::cout << "region materializations: " << *materializations
            << " (4 distinct codes on active rows)\n";

  try {
    const dlks::ExprPtr unguarded = dlks::Expr::binary(
        dlks::Op::Div, lit(dlks::Value(100)), col("amount"));
    const dlks::Program program = dlks::compile(unguarded, batch, registry);
    (void)dlks::VectorEngine(batch).evaluate_or_throw(program, selection);
  } catch (const dlks::EvalError& error) {
    std::cout << "unguarded:    " << error.what() << "\n";
  }

  return 0;
}
