#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "dlks_formal.hpp"
#include "test_framework.hpp"

namespace testhelp {

inline dlks::Vector int_values(std::vector<dlks::Value> values) {
  return dlks::Vector::from_values(dlks::Type::Int64, values);
}

inline dlks::Vector double_values(std::vector<dlks::Value> values) {
  return dlks::Vector::from_values(dlks::Type::Double, values);
}

inline dlks::Vector bool_values(std::vector<dlks::Value> values) {
  return dlks::Vector::from_values(dlks::Type::Bool, values);
}

inline dlks::Vector string_values(std::vector<dlks::Value> values) {
  return dlks::Vector::from_values(dlks::Type::String, values);
}

inline std::shared_ptr<dlks::InMemoryColumn> column(dlks::Vector vector) {
  return std::make_shared<dlks::InMemoryColumn>(std::move(vector));
}

inline void require_match(const dlks::Evaluation& expected, const dlks::Evaluation& actual,
                          const char* file, int line) {
  const auto divergence = dlks::compare_evaluations(expected, actual);
  if (divergence.has_value()) {
    ::testfw::fail(file, line, divergence->area + ": " + divergence->detail + "\n  expected: " +
                                   dlks::describe_evaluation(expected) +
                                   "\n  actual:   " + dlks::describe_evaluation(actual));
  }
}

inline std::uint32_t node_id_matching(const dlks::Program& program, std::string_view needle) {
  for (const dlks::Expr* node : program.nodes) {
    if (dlks::label(*node).find(needle) != std::string::npos) {
      return program.node_id(*node);
    }
  }
  ::testfw::fail(__FILE__, __LINE__, "no expression node matches '" + std::string(needle) + "'");
}

}  // namespace testhelp

#define REQUIRE_MATCH(expected, actual) \
  ::testhelp::require_match((expected), (actual), __FILE__, __LINE__)
