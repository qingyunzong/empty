#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "dlks/column.hpp"
#include "dlks/eval.hpp"
#include "dlks/expr.hpp"
#include "dlks/kernel.hpp"

namespace dlks {

// Row-at-a-time reference interpreter. It follows the same evaluation order as
// VectorEngine: left operands before right operands, FALSE/TRUE short-circuit
// for AND/OR, lazy if/coalesce branches, and no evaluation after a row-local
// error. It is intentionally independent of the batch/selection machinery so
// that differential tests catch assembly, null-bitmap and short-circuit bugs.
class ScalarEngine {
 public:
  explicit ScalarEngine(const Batch& batch) : batch_(batch) {}

  Evaluation evaluate(const Program& program, const Selection& selection) const {
    for (const std::uint32_t row : selection) {
      if (row >= batch_.size()) {
        throw std::out_of_range("selection row " + std::to_string(row) + " out of range (batch " +
                                std::to_string(batch_.size()) + " rows)");
      }
    }
    Evaluation result{Vector(program.result_type, selection.size()),
                      std::vector<ErrorInfo>(selection.size())};
    for (std::size_t position = 0; position < selection.size(); ++position) {
      ErrorInfo error;
      const Value value = eval(*program.root, program, selection[position], error);
      if (!error.ok()) {
        result.errors[position] = std::move(error);
      } else if (!value.is_null()) {
        result.values.set(position, value);
      }
    }
    return result;
  }

  Vector evaluate_or_throw(const Program& program, const Selection& selection) const {
    Evaluation result = evaluate(program, selection);
    throw_if_failed(program, selection, result);
    return std::move(result.values);
  }

 private:
  Value fail(ErrorInfo& error, std::uint32_t node_id, const std::string& message) const {
    error = ErrorInfo{node_id, message};
    return Value{};
  }

  Value coerce(Value value, Type target, ErrorInfo& error, std::uint32_t node_id) const {
    if (value.is_null() || value.type() == target) {
      return value;
    }
    try {
      return apply_cast(value, target);
    } catch (const KernelError& failure) {
      return fail(error, node_id, failure.what());
    }
  }

  Value eval(const Expr& node, const Program& program, std::uint32_t row,
             ErrorInfo& error) const {
    const std::uint32_t node_id = program.node_id(node);

    switch (node.kind()) {
      case Expr::Kind::Literal:
        return node.literal_value();
      case Expr::Kind::Column: {
        const Column* column = batch_.find(node.name());
        if (column == nullptr) {
          throw std::logic_error("unbound column '" + node.name() + "'");
        }
        try {
          return column->value(row);
        } catch (const std::exception& failure) {
          return fail(error, node_id, failure.what());
        } catch (...) {
          return fail(error, node_id, "column read failed");
        }
      }
      case Expr::Kind::Unary: {
        const Value child = eval(*node.children()[0], program, row, error);
        if (!error.ok()) {
          return Value{};
        }
        try {
          return apply_unary(node.op(), child);
        } catch (const KernelError& failure) {
          return fail(error, node_id, failure.what());
        }
      }
      case Expr::Kind::Cast: {
        const Value child = eval(*node.children()[0], program, row, error);
        if (!error.ok()) {
          return Value{};
        }
        try {
          return apply_cast(child, node.cast_type());
        } catch (const KernelError& failure) {
          return fail(error, node_id, failure.what());
        }
      }
      case Expr::Kind::IsNull: {
        const Value child = eval(*node.children()[0], program, row, error);
        if (!error.ok()) {
          return Value{};
        }
        return Value(child.is_null());
      }
      case Expr::Kind::Binary: {
        if (node.op() == Op::And || node.op() == Op::Or) {
          const bool is_and = node.op() == Op::And;
          const Value lhs = eval(*node.children()[0], program, row, error);
          if (!error.ok()) {
            return Value{};
          }
          if (!lhs.is_null() && lhs.as_bool() != is_and) {
            return Value(lhs.as_bool());
          }
          const Value rhs = eval(*node.children()[1], program, row, error);
          if (!error.ok()) {
            return Value{};
          }
          if (lhs.is_null()) {
            if (!rhs.is_null() && rhs.as_bool() != is_and) {
              return Value(rhs.as_bool());
            }
            return Value{};
          }
          return rhs;
        }

        const Value lhs = eval(*node.children()[0], program, row, error);
        if (!error.ok()) {
          return Value{};
        }
        // NULL operands do not short-circuit: the right side is still evaluated
        // (and may raise its own error), matching vectorized evaluation.
        const Value rhs = eval(*node.children()[1], program, row, error);
        if (!error.ok()) {
          return Value{};
        }
        try {
          return apply_binary(node.op(), lhs, rhs);
        } catch (const KernelError& failure) {
          return fail(error, node_id, failure.what());
        }
      }
      case Expr::Kind::If: {
        const Value condition = eval(*node.children()[0], program, row, error);
        if (!error.ok() || condition.is_null()) {
          return Value{};
        }
        const Value branch = condition.as_bool()
                                 ? eval(*node.children()[1], program, row, error)
                                 : eval(*node.children()[2], program, row, error);
        if (!error.ok()) {
          return Value{};
        }
        return coerce(branch, program.type_of(node), error, node_id);
      }
      case Expr::Kind::Coalesce: {
        const Value first = eval(*node.children()[0], program, row, error);
        if (!error.ok()) {
          return first;
        }
        if (!first.is_null()) {
          return coerce(first, program.type_of(node), error, node_id);
        }
        const Value second = eval(*node.children()[1], program, row, error);
        if (!error.ok()) {
          return second;
        }
        return coerce(second, program.type_of(node), error, node_id);
      }
      case Expr::Kind::Call: {
        const FunctionDef* function = program.function(node);
        std::vector<Value> arguments;
        arguments.reserve(node.children().size());
        for (const ExprPtr& child : node.children()) {
          arguments.push_back(eval(*child, program, row, error));
          if (!error.ok()) {
            return Value{};
          }
        }
        for (const Value& argument : arguments) {
          if (argument.is_null()) {
            return Value{};
          }
        }
        try {
          return invoke_function(*function, arguments);
        } catch (const KernelError& failure) {
          return fail(error, node_id, failure.what());
        }
      }
    }
    throw std::logic_error("unknown expression kind");
  }

  const Batch& batch_;
};

}  // namespace dlks
