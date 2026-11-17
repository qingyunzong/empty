#pragma once

#include <cstddef>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "dlks/column.hpp"
#include "dlks/eval.hpp"
#include "dlks/expr.hpp"
#include "dlks/kernel.hpp"

namespace dlks {

namespace detail {

inline Selection gather(const Selection& selection,
                        const std::vector<std::uint32_t>& positions) {
  Selection gathered;
  gathered.reserve(positions.size());
  for (const std::uint32_t position : positions) {
    gathered.push_back(selection[position]);
  }
  return gathered;
}

}  // namespace detail

// Batch-at-a-time evaluator. Every node consumes a selection and produces a
// Vector aligned with it. Boolean operators and conditional expressions narrow
// the selection for their right/branch children, so dangerous operations are
// never executed on rows that short-circuit.
class VectorEngine {
 public:
  explicit VectorEngine(const Batch& batch) : batch_(batch) {}

  Evaluation evaluate(const Program& program, const Selection& selection) const {
    check_selection(selection);
    EvalResult result = eval(*program.root, program, selection);
    return Evaluation{std::move(result.values), std::move(result.errors)};
  }

  Vector evaluate_or_throw(const Program& program, const Selection& selection) const {
    Evaluation result = evaluate(program, selection);
    throw_if_failed(program, selection, result);
    return std::move(result.values);
  }

 private:
  struct EvalResult {
    Vector values;
    std::vector<ErrorInfo> errors;
  };

  void check_selection(const Selection& selection) const {
    for (const std::uint32_t row : selection) {
      if (row >= batch_.size()) {
        throw std::out_of_range("selection row " + std::to_string(row) + " out of range (batch " +
                                std::to_string(batch_.size()) + " rows)");
      }
    }
  }

  EvalResult eval(const Expr& node, const Program& program, const Selection& selection) const {
    const std::size_t row_count = selection.size();
    const std::uint32_t node_id = program.node_id(node);

    switch (node.kind()) {
      case Expr::Kind::Literal: {
        Vector values(program.type_of(node), row_count);
        const Value& literal = node.literal_value();
        if (!literal.is_null()) {
          for (std::size_t i = 0; i < row_count; ++i) {
            values.set(i, literal);
          }
        }
        return EvalResult{std::move(values), std::vector<ErrorInfo>(row_count)};
      }
      case Expr::Kind::Column: {
        const Column* column = batch_.find(node.name());
        if (column == nullptr) {
          throw std::logic_error("unbound column '" + node.name() + "'");
        }
        ReadResult read = column->read(selection);
        EvalResult result{std::move(read.values), std::vector<ErrorInfo>(row_count)};
        for (std::size_t i = 0; i < row_count; ++i) {
          if (!read.errors[i].empty()) {
            result.errors[i] = ErrorInfo{node_id, read.errors[i]};
          }
        }
        return result;
      }
      case Expr::Kind::Unary: {
        EvalResult child = eval(*node.children()[0], program, selection);
        EvalResult result{Vector(program.type_of(node), row_count), std::move(child.errors)};
        for (std::size_t i = 0; i < row_count; ++i) {
          if (!result.errors[i].ok()) {
            continue;
          }
          try {
            const Value value = apply_unary(node.op(), child.values.value(i));
            if (!value.is_null()) {
              result.values.set(i, value);
            }
          } catch (const KernelError& error) {
            result.errors[i] = ErrorInfo{node_id, error.what()};
          }
        }
        return result;
      }
      case Expr::Kind::Cast: {
        EvalResult child = eval(*node.children()[0], program, selection);
        EvalResult result{Vector(program.type_of(node), row_count), std::move(child.errors)};
        for (std::size_t i = 0; i < row_count; ++i) {
          if (!result.errors[i].ok()) {
            continue;
          }
          try {
            const Value value = apply_cast(child.values.value(i), node.cast_type());
            if (!value.is_null()) {
              result.values.set(i, value);
            }
          } catch (const KernelError& error) {
            result.errors[i] = ErrorInfo{node_id, error.what()};
          }
        }
        return result;
      }
      case Expr::Kind::IsNull: {
        EvalResult child = eval(*node.children()[0], program, selection);
        Vector values(Type::Bool, row_count);
        for (std::size_t i = 0; i < row_count; ++i) {
          if (child.errors[i].ok()) {
            values.set_bool(i, child.values.is_null(i));
          }
        }
        return EvalResult{std::move(values), std::move(child.errors)};
      }
      case Expr::Kind::Binary:
        return eval_binary(node, program, selection);
      case Expr::Kind::If:
        return eval_if(node, program, selection);
      case Expr::Kind::Coalesce:
        return eval_coalesce(node, program, selection);
      case Expr::Kind::Call:
        return eval_call(node, program, selection);
    }
    throw std::logic_error("unknown expression kind");
  }

  EvalResult eval_binary(const Expr& node, const Program& program,
                         const Selection& selection) const {
    if (node.op() == Op::And || node.op() == Op::Or) {
      return eval_boolean(node, program, selection);
    }

    const std::size_t row_count = selection.size();
    const std::uint32_t node_id = program.node_id(node);
    EvalResult lhs = eval(*node.children()[0], program, selection);

    std::vector<std::uint32_t> active;
    active.reserve(row_count);
    for (std::size_t i = 0; i < row_count; ++i) {
      if (lhs.errors[i].ok()) {
        active.push_back(static_cast<std::uint32_t>(i));
      }
    }

    // NULL does not short-circuit arithmetic or comparisons, but an error on
    // the left does: the right subtree is not evaluated for those rows.
    EvalResult rhs = eval(*node.children()[1], program, detail::gather(selection, active));

    EvalResult result{Vector(program.type_of(node), row_count), std::vector<ErrorInfo>(row_count)};
    std::size_t rhs_position = 0;
    for (std::size_t i = 0; i < row_count; ++i) {
      if (!lhs.errors[i].ok()) {
        result.errors[i] = lhs.errors[i];
        continue;
      }
      const ErrorInfo rhs_error = rhs.errors[rhs_position];
      const Value rhs_value = rhs.values.value(rhs_position);
      ++rhs_position;
      if (!rhs_error.ok()) {
        result.errors[i] = rhs_error;
        continue;
      }
      try {
        const Value value = apply_binary(node.op(), lhs.values.value(i), rhs_value);
        if (!value.is_null()) {
          result.values.set(i, value);
        }
      } catch (const KernelError& error) {
        result.errors[i] = ErrorInfo{node_id, error.what()};
      }
    }
    return result;
  }

  EvalResult eval_boolean(const Expr& node, const Program& program,
                          const Selection& selection) const {
    const std::size_t row_count = selection.size();
    const bool is_and = node.op() == Op::And;
    EvalResult lhs = eval(*node.children()[0], program, selection);

    std::vector<std::uint32_t> active;
    active.reserve(row_count);
    for (std::size_t i = 0; i < row_count; ++i) {
      if (!lhs.errors[i].ok()) {
        continue;
      }
      const Value value = lhs.values.value(i);
      const bool decided = !value.is_null() && (value.as_bool() != is_and);
      // AND is decided by FALSE; OR is decided by TRUE.
      if (!decided) {
        active.push_back(static_cast<std::uint32_t>(i));
      }
    }

    EvalResult rhs = eval(*node.children()[1], program, detail::gather(selection, active));

    EvalResult result{Vector(Type::Bool, row_count), std::vector<ErrorInfo>(row_count)};
    std::size_t rhs_position = 0;
    for (std::size_t i = 0; i < row_count; ++i) {
      if (!lhs.errors[i].ok()) {
        result.errors[i] = lhs.errors[i];
        continue;
      }
      const Value lhs_value = lhs.values.value(i);
      if (!lhs_value.is_null()) {
        const bool lhs_bool = lhs_value.as_bool();
        if (lhs_bool != is_and) {
          result.values.set_bool(i, lhs_bool);
          continue;
        }
      }

      const ErrorInfo rhs_error = rhs.errors[rhs_position];
      const Value rhs_value = rhs.values.value(rhs_position);
      ++rhs_position;
      if (!rhs_error.ok()) {
        result.errors[i] = rhs_error;
        continue;
      }
      if (lhs_value.is_null()) {
        // NULL AND FALSE = FALSE, NULL OR TRUE = TRUE; everything else NULL.
        if (!rhs_value.is_null() && rhs_value.as_bool() != is_and) {
          result.values.set_bool(i, rhs_value.as_bool());
        }
      } else if (!rhs_value.is_null()) {
        result.values.set_bool(i, rhs_value.as_bool());
      }
    }
    return result;
  }

  EvalResult eval_if(const Expr& node, const Program& program,
                     const Selection& selection) const {
    const std::size_t row_count = selection.size();
    const std::uint32_t node_id = program.node_id(node);
    const Type result_type = program.type_of(node);
    EvalResult condition = eval(*node.children()[0], program, selection);

    std::vector<std::uint32_t> true_positions;
    std::vector<std::uint32_t> false_positions;
    for (std::size_t i = 0; i < row_count; ++i) {
      if (!condition.errors[i].ok()) {
        continue;
      }
      const Value value = condition.values.value(i);
      if (value.is_null()) {
        continue;
      }
      if (value.as_bool()) {
        true_positions.push_back(static_cast<std::uint32_t>(i));
      } else {
        false_positions.push_back(static_cast<std::uint32_t>(i));
      }
    }

    EvalResult then_result =
        eval(*node.children()[1], program, detail::gather(selection, true_positions));
    EvalResult else_result =
        eval(*node.children()[2], program, detail::gather(selection, false_positions));

    EvalResult result{Vector(program.type_of(node), row_count), std::vector<ErrorInfo>(row_count)};
    std::size_t then_position = 0;
    std::size_t else_position = 0;
    for (std::size_t i = 0; i < row_count; ++i) {
      if (!condition.errors[i].ok()) {
        result.errors[i] = condition.errors[i];
        continue;
      }
      const Value value = condition.values.value(i);
      if (value.is_null()) {
        continue;
      }
      EvalResult* branch = value.as_bool() ? &then_result : &else_result;
      std::size_t& branch_position = value.as_bool() ? then_position : else_position;
      if (!branch->errors[branch_position].ok()) {
        result.errors[i] = branch->errors[branch_position];
        ++branch_position;
        continue;
      }
      Value branch_value = branch->values.value(branch_position);
      ++branch_position;
      if (branch_value.is_null()) {
        continue;
      }
      if (branch_value.type() != result_type) {
        try {
          branch_value = apply_cast(branch_value, result_type);
        } catch (const KernelError& error) {
          result.errors[i] = ErrorInfo{node_id, error.what()};
          continue;
        }
      }
      result.values.set(i, branch_value);
    }
    return result;
  }

  EvalResult eval_coalesce(const Expr& node, const Program& program,
                           const Selection& selection) const {
    const std::size_t row_count = selection.size();
    const std::uint32_t node_id = program.node_id(node);
    const Type result_type = program.type_of(node);
    EvalResult first = eval(*node.children()[0], program, selection);

    std::vector<std::uint32_t> need_second;
    for (std::size_t i = 0; i < row_count; ++i) {
      if (first.errors[i].ok() && first.values.is_null(i)) {
        need_second.push_back(static_cast<std::uint32_t>(i));
      }
    }

    EvalResult second =
        eval(*node.children()[1], program, detail::gather(selection, need_second));

    EvalResult result{Vector(program.type_of(node), row_count), std::vector<ErrorInfo>(row_count)};
    std::size_t second_position = 0;
    for (std::size_t i = 0; i < row_count; ++i) {
      if (!first.errors[i].ok()) {
        result.errors[i] = first.errors[i];
        continue;
      }
      const Value value = first.values.value(i);
      if (!value.is_null()) {
        try {
          result.values.set(i, value.type() == result_type
                                   ? value
                                   : apply_cast(value, result_type));
        } catch (const KernelError& error) {
          result.errors[i] = ErrorInfo{node_id, error.what()};
        }
        continue;
      }
      const ErrorInfo second_error = second.errors[second_position];
      const Value second_value = second.values.value(second_position);
      ++second_position;
      if (!second_error.ok()) {
        result.errors[i] = second_error;
      } else if (!second_value.is_null()) {
        try {
          result.values.set(i, second_value.type() == result_type
                                   ? second_value
                                   : apply_cast(second_value, result_type));
        } catch (const KernelError& error) {
          result.errors[i] = ErrorInfo{node_id, error.what()};
        }
      }
    }
    return result;
  }

  EvalResult eval_call(const Expr& node, const Program& program,
                       const Selection& selection) const {
    const std::size_t row_count = selection.size();
    const std::uint32_t node_id = program.node_id(node);
    const FunctionDef* function = program.function(node);
    const std::size_t arity = function->arg_types.size();

    std::vector<std::vector<Value>> arguments(arity, std::vector<Value>(row_count));
    std::vector<ErrorInfo> errors(row_count);
    std::vector<std::uint32_t> active(row_count);
    std::iota(active.begin(), active.end(), 0U);

    for (std::size_t argument = 0; argument < arity && !active.empty(); ++argument) {
      EvalResult value =
          eval(*node.children()[argument], program, detail::gather(selection, active));
      std::vector<std::uint32_t> next;
      next.reserve(active.size());
      for (std::size_t i = 0; i < active.size(); ++i) {
        const std::uint32_t position = active[i];
        arguments[argument][position] = value.values.value(i);
        if (!value.errors[i].ok()) {
          errors[position] = value.errors[i];
        } else {
          next.push_back(position);
        }
      }
      active.swap(next);
    }

    Vector values(program.type_of(node), row_count);
    std::vector<Value> call_arguments;
    call_arguments.reserve(arity);
    for (const std::uint32_t position : active) {
      bool has_null = false;
      call_arguments.clear();
      for (std::size_t argument = 0; argument < arity; ++argument) {
        if (arguments[argument][position].is_null()) {
          has_null = true;
          break;
        }
        call_arguments.push_back(arguments[argument][position]);
      }
      if (has_null) {
        continue;
      }
      try {
        const Value value = invoke_function(*function, call_arguments);
        if (!value.is_null()) {
          values.set(position, value);
        }
      } catch (const KernelError& error) {
        errors[position] = ErrorInfo{node_id, error.what()};
      }
    }
    return EvalResult{std::move(values), std::move(errors)};
  }

  const Batch& batch_;
};

}  // namespace dlks
