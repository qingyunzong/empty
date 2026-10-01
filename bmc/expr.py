"""Safe evaluation of guard / assignment / invariant expressions.

Expressions are a small Python-like subset: integer and boolean constants,
variable names, arithmetic (+, -, *, //, %, unary -), comparisons
(==, !=, <, <=, >, >=) and boolean connectives (and, or, not).

Reading a variable that is not defined in the current state raises
ReadError (error code E_READ).
"""

import ast


class EvalError(Exception):
    """Base class for expression evaluation errors."""

    code = "E_EVAL"


class ReadError(EvalError):
    """A read of an undefined variable."""

    code = "E_READ"

    def __init__(self, name):
        super().__init__(f"read of undefined variable {name!r}")
        self.name = name


_ALLOWED_NODES = (
    ast.Expression,
    ast.BoolOp,
    ast.BinOp,
    ast.UnaryOp,
    ast.Compare,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.And,
    ast.Or,
    ast.Not,
    ast.USub,
    ast.UAdd,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.FloorDiv,
    ast.Mod,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
)

_BIN_OPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
}

_CMP_OPS = {
    ast.Eq: lambda a, b: a == b,
    ast.NotEq: lambda a, b: a != b,
    ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b,
    ast.Gt: lambda a, b: a > b,
    ast.GtE: lambda a, b: a >= b,
}


def evaluate(source, state):
    """Evaluate expression string `source` against mapping `state`."""
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise EvalError(f"invalid expression {source!r}: {exc}") from exc
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise EvalError(
                f"unsupported syntax {type(node).__name__} in {source!r}"
            )
    return _eval(tree.body, state)


def _eval(node, state):
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (bool, int)):
            return node.value
        raise EvalError(f"unsupported constant {node.value!r}")
    if isinstance(node, ast.Name):
        if node.id in ("true", "True"):
            return True
        if node.id in ("false", "False"):
            return False
        if node.id not in state:
            raise ReadError(node.id)
        return state[node.id]
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
    if isinstance(node, ast.UnaryOp):
        operand = _eval(node.operand, state)
        if isinstance(node.op, ast.Not):
            return not operand
        if isinstance(node.op, ast.USub):
            return -_as_int(operand)
        return _as_int(operand)
    if isinstance(node, ast.BinOp):
        left = _as_int(_eval(node.left, state))
        right = _as_int(_eval(node.right, state))
        if isinstance(node.op, (ast.FloorDiv, ast.Mod)) and right == 0:
            raise EvalError("division by zero")
        return _BIN_OPS[type(node.op)](left, right)
    if isinstance(node, ast.Compare):
        left = _eval(node.left, state)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval(comparator, state)
            if not _CMP_OPS[type(op)](left, right):
                return False
            left = right
        return True
    raise EvalError(f"unsupported syntax {type(node).__name__}")


def _as_int(value):
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvalError(f"expected integer, got {value!r}")
    return value
