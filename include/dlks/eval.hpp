#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>

#include "dlks/expr.hpp"
#include "dlks/vector.hpp"

namespace dlks {

inline constexpr std::uint32_t kNoError = std::numeric_limits<std::uint32_t>::max();

struct ErrorInfo {
  std::uint32_t node_id = kNoError;
  std::string message;

  bool ok() const noexcept { return node_id == kNoError; }
};

// Result aligned positionally with the requested selection. An error position
// holds no meaningful value (the value slot is NULL) and records the first
// failing node encountered while evaluating that row.
struct Evaluation {
  Vector values;
  std::vector<ErrorInfo> errors;

  std::size_t error_count() const {
    std::size_t count = 0;
    for (const ErrorInfo& error : errors) {
      count += error.ok() ? 0 : 1;
    }
    return count;
  }

  bool ok() const { return error_count() == 0; }

  std::optional<std::size_t> first_error_position() const {
    for (std::size_t i = 0; i < errors.size(); ++i) {
      if (!errors[i].ok()) {
        return i;
      }
    }
    return std::nullopt;
  }
};

// Row-local failures are collected, not thrown mid-batch: this lets the
// vectorized engine keep the same first-error position as a row-at-a-time
// interpreter while still evaluating independent rows in batches.
class EvalError : public std::runtime_error {
 public:
  EvalError(std::size_t position, std::uint32_t row, std::uint32_t node_id, std::string node_label,
            std::string detail)
      : std::runtime_error(message(position, row, node_id, node_label, detail)),
        position_(position),
        row_(row),
        node_id_(node_id),
        node_label_(std::move(node_label)),
        detail_(std::move(detail)) {}

  std::size_t position() const noexcept { return position_; }
  std::uint32_t row() const noexcept { return row_; }
  std::uint32_t node_id() const noexcept { return node_id_; }
  const std::string& node_label() const noexcept { return node_label_; }
  const std::string& detail() const noexcept { return detail_; }

  static std::string message(std::size_t position, std::uint32_t row, std::uint32_t node_id,
                             const std::string& node_label, const std::string& detail) {
    std::ostringstream out;
    out << "evaluation error at selection position " << position << " (row " << row << "), node "
        << node_id;
    if (!node_label.empty()) {
      out << " [" << node_label << "]";
    }
    out << ": " << detail;
    return out.str();
  }

 private:
  std::size_t position_;
  std::uint32_t row_;
  std::uint32_t node_id_;
  std::string node_label_;
  std::string detail_;
};

inline EvalError make_eval_error(const Program& program, const Selection& selection,
                                 std::size_t position, const ErrorInfo& error) {
  const std::uint32_t row = position < selection.size() ? selection[position] : 0;
  std::string node_label;
  if (error.node_id != kNoError) {
    node_label = label(program.node(error.node_id));
  }
  return EvalError(position, row, error.node_id, std::move(node_label), error.message);
}

inline void throw_if_failed(const Program& program, const Selection& selection,
                            const Evaluation& evaluation) {
  const auto position = evaluation.first_error_position();
  if (position.has_value()) {
    throw make_eval_error(program, selection, *position, evaluation.errors[*position]);
  }
}

inline Value invoke_function(const FunctionDef& function, const std::vector<Value>& arguments) {
  Value result;
  try {
    result = function.fn(arguments);
  } catch (const std::exception& error) {
    throw KernelError("function '" + function.name + "' failed: " + error.what());
  } catch (...) {
    throw KernelError("function '" + function.name + "' failed: unknown exception");
  }
  if (!result.is_null() && result.type() != function.return_type) {
    throw KernelError("function '" + function.name + "' returned " +
                      std::string(type_name(result.type())) + ", expected " +
                      std::string(type_name(function.return_type)));
  }
  return result;
}

}  // namespace dlks
