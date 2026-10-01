"""Safe arithmetic/boolean expression evaluation for bmc models.

Expressions are parsed with :mod:`ast` and evaluated by walking a
whitelisted node set.  No ``eval``/``exec`` is ever used.
"""
from __future__ import annotations

import ast


class ExprError(Exception):
    """Base class for expression problems."""


class ExprSyntaxError(ExprError):
    """Expression uses constructs outside the modelling language."""


class UndefinedVariableError(ExprError):
    """A declared variable was read before being defined (E_READ)."""

    def __init__(self, name: str):
        super().__init__(f"read of undefined variable {name!r}")
        self.name = name


class EvaluationError(ExprError):
    """Runtime failure while evaluating (e.g. division by zero)."""


_BIN_OPS = (ast.Add, ast.Sub, ast.Mult, ast.FloorDiv, ast.Mod)
_UNARY_OPS = (ast.USub, ast.UAdd, ast.Not)
_BOOL_OPS = (ast.And, ast.Or)
_CMP_OPS = (ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Eq, ast.NotEq)


def _validate(node: ast.AST, names: frozenset) -> None:
    if isinstance(node, ast.Expression):
        _validate(node.body, names)
        return
    if isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, bool)):
            raise ExprSyntaxError(
                f"unsupported constant {node.value!r}; only integers and booleans"
            )
        return
    if isinstance(node, ast.Name):
        if node.id not in names:
            raise ExprSyntaxError(f"unknown variable {node.id!r}")
        return
    if isinstance(node, ast.BinOp):
        if not isinstance(node.op, _BIN_OPS):
            raise ExprSyntaxError(
                f"unsupported operator {ast.dump(node.op)}; "
                "allowed: + - * // %"
            )
        _validate(node.left, names)
        _validate(node.right, names)
        return
    if isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, _UNARY_OPS):
            raise ExprSyntaxError(f"unsupported unary operator {ast.dump(node.op)}")
        _validate(node.operand, names)
        return
    if isinstance(node, ast.BoolOp):
        if not isinstance(node.op, _BOOL_OPS):
            raise ExprSyntaxError(f"unsupported boolean operator {ast.dump(node.op)}")
        for value in node.values:
            _validate(value, names)
        return
    if isinstance(node, ast.Compare):
        for op in node.ops:
            if not isinstance(op, _CMP_OPS):
                raise ExprSyntaxError(
                    f"unsupported comparison {ast.dump(op)}"
                )
        _validate(node.left, names)
        for comparator in node.comparators:
            _validate(comparator, names)
        return
    raise ExprSyntaxError(f"unsupported syntax: {ast.dump(node)}")


def compile_expression(source: str, names) -> ast.Expression:
    """Parse and validate *source*; raise :class:`ExprSyntaxError` if invalid."""
    if not isinstance(source, str) or not source.strip():
        raise ExprSyntaxError("expression must be a non-empty string")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise ExprSyntaxError(f"cannot parse expression {source!r}: {exc.msg}") from exc
    _validate(tree, frozenset(names))
    return tree


def _require_int(value, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvaluationError(f"{what} must be an integer, got {value!r}")
    return value


def _eval(node: ast.AST, state: dict):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        try:
            return state[node.id]
        except KeyError:
            raise UndefinedVariableError(node.id) from None
    if isinstance(node, ast.BinOp):
        left = _require_int(_eval(node.left, state), "left operand")
        right = _require_int(_eval(node.right, state), "right operand")
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.FloorDiv):
            if right == 0:
                raise EvaluationError("division by zero")
            return left // right
        if isinstance(node.op, ast.Mod):
            if right == 0:
                raise EvaluationError("modulo by zero")
            return left % right
        raise EvaluationError(f"unsupported operator {ast.dump(node.op)}")
    if isinstance(node, ast.UnaryOp):
        operand = _eval(node.operand, state)
        if isinstance(node.op, ast.Not):
            return not operand
        operand = _require_int(operand, "unary operand")
        if isinstance(node.op, ast.USub):
            return -operand
        return operand
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            result = True
            for value in node.values:
                result = _eval(value, state)
                if not result:
                    return result
            return result
        result = False
        for value in node.values:
            result = _eval(value, state)
            if result:
                return result
        return result
    if isinstance(node, ast.Compare):
        left = _eval(node.left, state)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval(comparator, state)
            if isinstance(op, ast.Lt):
                ok = left < right
            elif isinstance(op, ast.LtE):
                ok = left <= right
            elif isinstance(op, ast.Gt):
                ok = left > right
            elif isinstance(op, ast.GtE):
                ok = left >= right
            elif isinstance(op, ast.Eq):
                ok = left == right
            else:
                ok = left != right
            if not ok:
                return False
            left = right
        return True
    raise EvaluationError(f"cannot evaluate node {ast.dump(node)}")


def evaluate(tree: ast.Expression, state: dict):
    """Evaluate a compiled expression against *state* (var -> int)."""
    return _eval(tree.body, state)
