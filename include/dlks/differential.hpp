#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "dlks/eval.hpp"

namespace dlks {

struct Divergence {
  std::string area;
  std::string detail;
};

inline std::string describe_evaluation(const Evaluation& evaluation) {
  std::ostringstream out;
  out << evaluation.values.describe();
  if (!evaluation.ok()) {
    out << " errors={";
    bool first = true;
    for (std::size_t i = 0; i < evaluation.errors.size(); ++i) {
      if (evaluation.errors[i].ok()) {
        continue;
      }
      if (!first) {
        out << ", ";
      }
      first = false;
      out << i << ":node" << evaluation.errors[i].node_id << ":" << evaluation.errors[i].message;
    }
    out << "}";
  }
  return out.str();
}

// Compares values, NULL bits and row-local errors. `expected` is normally the
// scalar oracle and `actual` the vectorized engine.
inline std::optional<Divergence> compare_evaluations(const Evaluation& expected,
                                                     const Evaluation& actual) {
  if (expected.values.type() != actual.values.type()) {
    return Divergence{"type", "result type: " + std::string(type_name(expected.values.type())) +
                                  " vs " + std::string(type_name(actual.values.type()))};
  }
  if (expected.values.size() != actual.values.size()) {
    return Divergence{"size", "result size: " + std::to_string(expected.values.size()) + " vs " +
                                  std::to_string(actual.values.size())};
  }
  if (expected.errors.size() != actual.errors.size()) {
    return Divergence{"error-size", "error vector size: " +
                                        std::to_string(expected.errors.size()) + " vs " +
                                        std::to_string(actual.errors.size())};
  }
  for (std::size_t i = 0; i < expected.values.size(); ++i) {
    const bool expected_null = expected.values.is_null(i);
    const bool actual_null = actual.values.is_null(i);
    if (expected_null != actual_null) {
      return Divergence{"null-bit", "position " + std::to_string(i) + ": expected " +
                                        (expected_null ? "NULL" : "value") + ", got " +
                                        (actual_null ? "NULL" : "value")};
    }
    if (!expected_null) {
      const Value expected_value = expected.values.value(i);
      const Value actual_value = actual.values.value(i);
      if (expected_value != actual_value) {
        return Divergence{"value", "position " + std::to_string(i) + ": expected " +
                                       expected_value.repr() + ", got " +
                                       actual_value.repr()};
      }
    }
    const bool expected_error = !expected.errors[i].ok();
    const bool actual_error = !actual.errors[i].ok();
    if (expected_error != actual_error) {
      return Divergence{"error-presence",
                        "position " + std::to_string(i) + ": expected " +
                            (expected_error ? "error" : "success") + ", got " +
                            (actual_error ? "error" : "success")};
    }
    if (expected_error) {
      if (expected.errors[i].node_id != actual.errors[i].node_id) {
        return Divergence{"error-node",
                          "position " + std::to_string(i) + ": expected node " +
                              std::to_string(expected.errors[i].node_id) + ", got node " +
                              std::to_string(actual.errors[i].node_id)};
      }
      if (expected.errors[i].message != actual.errors[i].message) {
        return Divergence{"error-message",
                          "position " + std::to_string(i) + ": expected '" +
                              expected.errors[i].message + "', got '" +
                              actual.errors[i].message + "'"};
      }
    }
  }
  return std::nullopt;
}

inline std::optional<Divergence> compare_counters(
    const std::map<std::string, std::uint64_t>& expected,
    const std::map<std::string, std::uint64_t>& actual) {
  if (expected != actual) {
    std::ostringstream out;
    out << "function call counters differ: expected {";
    bool first = true;
    for (const auto& [name, count] : expected) {
      if (!first) {
        out << ", ";
      }
      first = false;
      out << name << "=" << count;
    }
    out << "}, got {";
    first = true;
    for (const auto& [name, count] : actual) {
      if (!first) {
        out << ", ";
      }
      first = false;
      out << name << "=" << count;
    }
    out << "}";
    return Divergence{"call-count", out.str()};
  }
  return std::nullopt;
}

inline std::optional<Divergence> compare_code_sets(const std::vector<std::uint32_t>& expected,
                                                   const std::vector<std::uint32_t>& actual,
                                                   const std::string& column_name) {
  if (expected != actual) {
    std::ostringstream out;
    out << "dictionary '" << column_name << "' materialized codes differ: expected {";
    for (std::size_t i = 0; i < expected.size(); ++i) {
      if (i != 0) {
        out << ", ";
      }
      out << expected[i];
    }
    out << "}, got {";
    for (std::size_t i = 0; i < actual.size(); ++i) {
      if (i != 0) {
        out << ", ";
      }
      out << actual[i];
    }
    out << "}";
    return Divergence{"dictionary", out.str()};
  }
  return std::nullopt;
}

}  // namespace dlks
