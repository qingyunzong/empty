#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "dlks/column.hpp"
#include "dlks/kernel.hpp"
#include "dlks/value.hpp"

namespace dlks {

class CompileError : public std::runtime_error {
 public:
  explicit CompileError(const std::string& message) : std::runtime_error(message) {}
};

class Expr;
using ExprPtr = std::shared_ptr<const Expr>;

// A scalar function with a fixed signature. Functions are strict: the engines
// do not invoke them when any argument is NULL.
struct FunctionDef {
  std::string name;
  std::vector<Type> arg_types;
  Type return_type = Type::Null;
  std::function<Value(const std::vector<Value>&)> fn;
};

class Registry {
 public:
  void add(FunctionDef definition) {
    if (definition.name.empty()) {
      throw std::invalid_argument("function name must not be empty");
    }
    if (!definition.fn) {
      throw std::invalid_argument("function '" + definition.name + "' has no implementation");
    }
    if (definition.return_type == Type::Null) {
      throw std::invalid_argument("function '" + definition.name +
                                  "' must declare a concrete return type");
    }
    functions_[definition.name] = std::move(definition);
  }

  const FunctionDef* find(std::string_view name) const {
    const auto found = functions_.find(name);
    return found == functions_.end() ? nullptr : &found->second;
  }

  const std::map<std::string, FunctionDef, std::less<>>& functions() const noexcept {
    return functions_;
  }

 private:
  std::map<std::string, FunctionDef, std::less<>> functions_;
};

// Expression tree. Nodes are immutable and hash-consing is not required; node
// ids are assigned in post-order by compile() so that for any evaluation
// order, children have smaller ids than their parent.
class Expr {
 public:
  enum class Kind : std::uint8_t {
    Literal,
    Column,
    Unary,
    Binary,
    Cast,
    If,
    Coalesce,
    IsNull,
    Call
  };

  static ExprPtr literal(Value value) {
    return ExprPtr(new Expr(Kind::Literal, Op::Add, std::move(value), {}, Type::Null, {}));
  }

  static ExprPtr column(std::string name) {
    if (name.empty()) {
      throw std::invalid_argument("column name must not be empty");
    }
    return ExprPtr(new Expr(Kind::Column, Op::Add, Value{}, std::move(name), Type::Null, {}));
  }

  static ExprPtr unary(Op op, ExprPtr child) {
    if (op != Op::Neg && op != Op::Not) {
      throw std::invalid_argument("unary() requires Neg or Not");
    }
    if (!child) {
      throw std::invalid_argument("unary expression requires a child");
    }
    return ExprPtr(new Expr(Kind::Unary, op, Value{}, {}, Type::Null, {std::move(child)}));
  }

  static ExprPtr binary(Op op, ExprPtr lhs, ExprPtr rhs) {
    if (op == Op::Neg || op == Op::Not) {
      throw std::invalid_argument("binary() requires a binary operator");
    }
    if (!lhs || !rhs) {
      throw std::invalid_argument("binary expression requires two children");
    }
    return ExprPtr(new Expr(Kind::Binary, op, Value{}, {}, Type::Null,
                            {std::move(lhs), std::move(rhs)}));
  }

  static ExprPtr cast_to(ExprPtr child, Type target) {
    if (!child) {
      throw std::invalid_argument("cast expression requires a child");
    }
    return ExprPtr(new Expr(Kind::Cast, Op::Add, Value{}, {}, target, {std::move(child)}));
  }

  static ExprPtr if_then_else(ExprPtr condition, ExprPtr then_expr, ExprPtr else_expr) {
    if (!condition || !then_expr || !else_expr) {
      throw std::invalid_argument("if expression requires three children");
    }
    return ExprPtr(new Expr(Kind::If, Op::Add, Value{}, {}, Type::Null,
                            {std::move(condition), std::move(then_expr),
                             std::move(else_expr)}));
  }

  static ExprPtr coalesce(ExprPtr first, ExprPtr second) {
    if (!first || !second) {
      throw std::invalid_argument("coalesce expression requires two children");
    }
    return ExprPtr(new Expr(Kind::Coalesce, Op::Add, Value{}, {}, Type::Null,
                            {std::move(first), std::move(second)}));
  }

  static ExprPtr is_null(ExprPtr child) {
    if (!child) {
      throw std::invalid_argument("is_null expression requires a child");
    }
    return ExprPtr(new Expr(Kind::IsNull, Op::Add, Value{}, {}, Type::Null,
                            {std::move(child)}));
  }

  static ExprPtr call(std::string function, std::vector<ExprPtr> arguments) {
    if (function.empty()) {
      throw std::invalid_argument("function name must not be empty");
    }
    for (const ExprPtr& argument : arguments) {
      if (!argument) {
        throw std::invalid_argument("function argument must not be null");
      }
    }
    return ExprPtr(new Expr(Kind::Call, Op::Add, Value{}, std::move(function), Type::Null,
                            std::move(arguments)));
  }

  Kind kind() const noexcept { return kind_; }
  Op op() const noexcept { return op_; }
  const Value& literal_value() const noexcept { return literal_; }
  const std::string& name() const noexcept { return name_; }
  Type cast_type() const noexcept { return cast_type_; }
  const std::vector<ExprPtr>& children() const noexcept { return children_; }

 private:
  Expr(Kind kind, Op op, Value literal, std::string name, Type cast_type,
       std::vector<ExprPtr> children)
      : kind_(kind),
        op_(op),
        literal_(std::move(literal)),
        name_(std::move(name)),
        cast_type_(cast_type),
        children_(std::move(children)) {}

  Kind kind_;
  Op op_;
  Value literal_;
  std::string name_;
  Type cast_type_;
  std::vector<ExprPtr> children_;
};

inline std::string label(const Expr& expr) {
  switch (expr.kind()) {
    case Expr::Kind::Literal: return "literal " + expr.literal_value().repr();
    case Expr::Kind::Column: return "column '" + expr.name() + "'";
    case Expr::Kind::Unary: return std::string(op_name(expr.op()));
    case Expr::Kind::Binary: return std::string(op_name(expr.op()));
    case Expr::Kind::Cast: return "cast<" + std::string(type_name(expr.cast_type())) + ">";
    case Expr::Kind::If: return "if";
    case Expr::Kind::Coalesce: return "coalesce";
    case Expr::Kind::IsNull: return "is_null";
    case Expr::Kind::Call: return "call '" + expr.name() + "'";
  }
  return "?";
}

inline std::string to_string(const Expr& expr) {
  switch (expr.kind()) {
    case Expr::Kind::Literal:
      return expr.literal_value().repr();
    case Expr::Kind::Column:
      return expr.name();
    case Expr::Kind::Unary:
      return "(" + std::string(op_symbol(expr.op())) + " " + to_string(*expr.children()[0]) + ")";
    case Expr::Kind::Binary:
      return "(" + to_string(*expr.children()[0]) + " " + std::string(op_symbol(expr.op())) + " " +
             to_string(*expr.children()[1]) + ")";
    case Expr::Kind::Cast:
      return "cast<" + std::string(type_name(expr.cast_type())) + ">(" +
             to_string(*expr.children()[0]) + ")";
    case Expr::Kind::If:
      return "if(" + to_string(*expr.children()[0]) + ", " + to_string(*expr.children()[1]) +
             ", " + to_string(*expr.children()[2]) + ")";
    case Expr::Kind::Coalesce:
      return "coalesce(" + to_string(*expr.children()[0]) + ", " +
             to_string(*expr.children()[1]) + ")";
    case Expr::Kind::IsNull:
      return "is_null(" + to_string(*expr.children()[0]) + ")";
    case Expr::Kind::Call: {
      std::string out = expr.name() + "(";
      for (std::size_t i = 0; i < expr.children().size(); ++i) {
        if (i != 0) {
          out += ", ";
        }
        out += to_string(*expr.children()[i]);
      }
      out.push_back(')');
      return out;
    }
  }
  return "?";
}

struct Program {
  ExprPtr root;
  Type result_type = Type::Null;
  std::unordered_map<const Expr*, Type> types;
  std::unordered_map<const Expr*, std::uint32_t> ids;
  std::unordered_map<const Expr*, FunctionDef> functions;
  std::vector<const Expr*> nodes;  // index == node id

  Type type_of(const Expr& expr) const { return types.at(&expr); }
  std::uint32_t node_id(const Expr& expr) const { return ids.at(&expr); }

  const Expr& node(std::uint32_t id) const {
    if (id >= nodes.size()) {
      throw std::out_of_range("expression node id out of range");
    }
    return *nodes[id];
  }

  const FunctionDef* function(const Expr& expr) const { return &functions.at(&expr); }
};

namespace detail {

inline Type common_type(Type lhs, Type rhs, std::string_view where) {
  if (lhs == rhs) {
    return lhs;
  }
  if (lhs == Type::Null) {
    return rhs;
  }
  if (rhs == Type::Null) {
    return lhs;
  }
  if (is_numeric(lhs) && is_numeric(rhs)) {
    return Type::Double;
  }
  throw CompileError("type mismatch in " + std::string(where) + ": " +
                     std::string(type_name(lhs)) + " vs " + std::string(type_name(rhs)));
}

inline void require_bool(Type type, std::string_view where) {
  if (type != Type::Bool && type != Type::Null) {
    throw CompileError(std::string(where) + " requires a boolean operand, got " +
                       std::string(type_name(type)));
  }
}

inline void require_numeric(Type type, std::string_view where) {
  if (!is_numeric(type) && type != Type::Null) {
    throw CompileError(std::string(where) + " requires a numeric operand, got " +
                       std::string(type_name(type)));
  }
}

inline bool comparable(Type lhs, Type rhs) {
  return lhs == Type::Null || rhs == Type::Null || lhs == rhs ||
         (is_numeric(lhs) && is_numeric(rhs));
}

class Compiler {
 public:
  Compiler(const Batch& batch, const Registry& registry) : batch_(batch), registry_(registry) {}

  Program run(const ExprPtr& root) {
    if (!root) {
      throw CompileError("expression root must not be null");
    }
    program_.root = root;
    program_.result_type = visit(root.get());
    return std::move(program_);
  }

 private:
  Type visit(const Expr* expr) {
    const auto memo = program_.types.find(expr);
    if (memo != program_.types.end()) {
      return memo->second;
    }

    Type type = Type::Null;
    switch (expr->kind()) {
      case Expr::Kind::Literal:
        type = expr->literal_value().type();
        break;
      case Expr::Kind::Column: {
        const Column* column = batch_.find(expr->name());
        if (column == nullptr) {
          throw CompileError("unknown column '" + expr->name() + "'");
        }
        type = column->type();
        break;
      }
      case Expr::Kind::Unary: {
        const Type child = visit(expr->children()[0].get());
        if (expr->op() == Op::Not) {
          require_bool(child, "operator 'not'");
          type = Type::Bool;
        } else {
          require_numeric(child, "unary '-'");
          type = child;
        }
        break;
      }
      case Expr::Kind::Binary: {
        const Type lhs = visit(expr->children()[0].get());
        const Type rhs = visit(expr->children()[1].get());
        switch (expr->op()) {
          case Op::Add:
          case Op::Sub:
          case Op::Mul:
          case Op::Div:
            require_numeric(lhs, "operator '" + std::string(op_symbol(expr->op())) + "'");
            require_numeric(rhs, "operator '" + std::string(op_symbol(expr->op())) + "'");
            type = common_type(lhs, rhs, "arithmetic");
            break;
          case Op::Mod:
            if ((lhs != Type::Int64 && lhs != Type::Null) ||
                (rhs != Type::Int64 && rhs != Type::Null)) {
              throw CompileError("operator '%' requires int64 operands, got " +
                                 std::string(type_name(lhs)) + " and " +
                                 std::string(type_name(rhs)));
            }
            type = common_type(lhs, rhs, "modulo");
            break;
          case Op::And:
          case Op::Or:
            require_bool(lhs, "operator '" + std::string(op_symbol(expr->op())) + "'");
            require_bool(rhs, "operator '" + std::string(op_symbol(expr->op())) + "'");
            type = Type::Bool;
            break;
          default:
            if (!comparable(lhs, rhs)) {
              throw CompileError("cannot compare " + std::string(type_name(lhs)) + " and " +
                                 std::string(type_name(rhs)));
            }
            type = Type::Bool;
            break;
        }
        break;
      }
      case Expr::Kind::Cast: {
        const Type child = visit(expr->children()[0].get());
        if (!is_castable(child, expr->cast_type())) {
          throw CompileError("cannot cast " + std::string(type_name(child)) + " to " +
                             std::string(type_name(expr->cast_type())));
        }
        type = expr->cast_type();
        break;
      }
      case Expr::Kind::If: {
        const Type condition = visit(expr->children()[0].get());
        require_bool(condition, "if condition");
        const Type then_type = visit(expr->children()[1].get());
        const Type else_type = visit(expr->children()[2].get());
        type = common_type(then_type, else_type, "if branches");
        break;
      }
      case Expr::Kind::Coalesce: {
        const Type first = visit(expr->children()[0].get());
        const Type second = visit(expr->children()[1].get());
        type = common_type(first, second, "coalesce");
        break;
      }
      case Expr::Kind::IsNull:
        visit(expr->children()[0].get());
        type = Type::Bool;
        break;
      case Expr::Kind::Call: {
        const FunctionDef* function = registry_.find(expr->name());
        if (function == nullptr) {
          throw CompileError("unknown function '" + expr->name() + "'");
        }
        if (expr->children().size() != function->arg_types.size()) {
          throw CompileError("function '" + expr->name() + "' expects " +
                             std::to_string(function->arg_types.size()) + " arguments, got " +
                             std::to_string(expr->children().size()));
        }
        program_.functions.emplace(expr, *function);
        for (std::size_t i = 0; i < expr->children().size(); ++i) {
          const Type argument = visit(expr->children()[i].get());
          const Type expected = function->arg_types[i];
          if (argument != expected && argument != Type::Null) {
            throw CompileError("function '" + expr->name() + "' argument " +
                               std::to_string(i + 1) + " expects " +
                               std::string(type_name(expected)) + ", got " +
                               std::string(type_name(argument)));
          }
        }
        type = function->return_type;
        break;
      }
    }

    program_.types.emplace(expr, type);
    program_.ids.emplace(expr, static_cast<std::uint32_t>(program_.nodes.size()));
    program_.nodes.push_back(expr);
    return type;
  }

  const Batch& batch_;
  const Registry& registry_;
  Program program_;
};

}  // namespace detail

inline Program compile(const ExprPtr& root, const Batch& batch, const Registry& registry) {
  return detail::Compiler(batch, registry).run(root);
}

}  // namespace dlks
