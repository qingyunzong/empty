"""Safe expression evaluation with SQL-style three-valued logic.

Expressions are a restricted subset of Python expression syntax, parsed
with :mod:`ast`.  Column references resolve against the table schema;
referencing a column that is not in the schema raises
``PolicyError("E_SCHEMA", ...)``.

Three-valued logic (Kleene semantics): a comparison involving NULL
(data value ``None``) yields ``UNKNOWN`` -- never ``False``.  ``NOT``,
``AND`` and ``OR`` propagate ``UNKNOWN`` according to the standard
truth tables, so ``NOT UNKNOWN`` is ``UNKNOWN``, ``TRUE OR UNKNOWN``
is ``TRUE`` and ``FALSE AND UNKNOWN`` is ``FALSE``.
"""
from __future__ import annotations

import ast

from .errors import PolicyError


class _Unknown:
    """Singleton sentinel for the UNKNOWN truth value."""

    def __repr__(self):  # pragma: no cover - cosmetic
        return "UNKNOWN"

    def __bool__(self):
        raise PolicyError("E_EXPR", "UNKNOWN cannot be used as a boolean")


UNKNOWN = _Unknown()

_LITERAL_NAMES = {"null": None, "true": True, "false": False}


def tri_not(value):
    if value is UNKNOWN:
        return UNKNOWN
    return not value


def tri_and(left, right):
    if left is False or right is False:
        return False
    if left is UNKNOWN or right is UNKNOWN:
        return UNKNOWN
    return True


def tri_or(left, right):
    if left is True or right is True:
        return True
    if left is UNKNOWN or right is UNKNOWN:
        return UNKNOWN
    return False


def parse(expression_text):
    """Parse expression source into an AST, raising E_EXPR on bad syntax."""
    if not isinstance(expression_text, str):
        raise PolicyError("E_EXPR", f"expression must be a string, got {type(expression_text).__name__}")
    try:
        return ast.parse(expression_text, mode="eval").body
    except SyntaxError as exc:
        raise PolicyError("E_EXPR", f"invalid expression {expression_text!r}: {exc}") from exc


def expression_columns(node):
    """Return the set of column names referenced by a parsed expression."""
    return {
        n.id
        for n in ast.walk(node)
        if isinstance(n, ast.Name) and n.id not in _LITERAL_NAMES
    }


def evaluate(node, row, schema):
    """Evaluate a parsed expression against a row.

    ``schema`` is a set of known column names.  Returns a Python value;
    boolean contexts yield ``True``, ``False`` or ``UNKNOWN``.
    """
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _LITERAL_NAMES:
            return _LITERAL_NAMES[node.id]
        if node.id not in schema:
            raise PolicyError("E_SCHEMA", f"unknown column {node.id!r} in expression")
        return row.get(node.id)
    if isinstance(node, ast.BoolOp):
        values = [evaluate(item, row, schema) for item in node.values]
        for value in values:
            _require_bool(value)
        combine = tri_and if isinstance(node.op, ast.And) else None
        if combine is None:
            if not isinstance(node.op, ast.Or):
                raise PolicyError("E_EXPR", f"unsupported boolean operator {ast.dump(node.op)}")
            combine = tri_or
        result = values[0]
        for value in values[1:]:
            result = combine(result, value)
        return result
    if isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, ast.Not):
            raise PolicyError("E_EXPR", "only 'not' is supported as a unary operator")
        operand = evaluate(node.operand, row, schema)
        _require_bool(operand)
        return tri_not(operand)
    if isinstance(node, ast.Compare):
        return _evaluate_compare(node, row, schema)
    if isinstance(node, (ast.List, ast.Tuple)):
        return [evaluate(item, row, schema) for item in node.elts]
    raise PolicyError("E_EXPR", f"unsupported expression element {ast.dump(node)}")


def _require_bool(value):
    if value is UNKNOWN or isinstance(value, bool):
        return
    raise PolicyError("E_EXPR", f"expected a boolean operand, got {value!r}")


_COMPARE_OPS = {
    ast.Eq: lambda a, b: a == b,
    ast.NotEq: lambda a, b: a != b,
    ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b,
    ast.Gt: lambda a, b: a > b,
    ast.GtE: lambda a, b: a >= b,
    ast.In: lambda a, b: a in b,
    ast.NotIn: lambda a, b: a not in b,
}


def _evaluate_compare(node, row, schema):
    operands = [evaluate(node.left, row, schema)]
    operands.extend(evaluate(comparator, row, schema) for comparator in node.comparators)
    result = True
    for op, left, right in zip(node.ops, operands, operands[1:]):
        if isinstance(op, ast.Is):
            term = left is None
        elif isinstance(op, ast.IsNot):
            term = left is not None
        else:
            func = _COMPARE_OPS.get(type(op))
            if func is None:
                raise PolicyError("E_EXPR", f"unsupported comparison operator {ast.dump(op)}")
            if left is None or right is None or left is UNKNOWN or right is UNKNOWN:
                term = UNKNOWN
            else:
                try:
                    term = bool(func(left, right))
                except TypeError as exc:
                    raise PolicyError("E_EXPR", f"cannot compare {left!r} and {right!r}") from exc
        result = tri_and(result, term)
        if result is False:
            break
    return result
