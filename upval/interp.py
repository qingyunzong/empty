"""Compiled-style interpreter.

Locals live in frame slots.  Locals that the escape analysis marked as
boxed are promoted to heap ``Cell``s shared by every capturing closure;
unboxed captures reference the owner frame directly (only possible for
non-escaping closures, so the frame is guaranteed to be alive).
"""

from . import parser as ast
from .errors import (
    ArityError,
    DivZero,
    NotCallable,
    TypeMismatch,
    UninitializedVar,
)

UNSET = object()


class Cell:
    __slots__ = ("value",)

    def __init__(self, value):
        self.value = value


class FrameRef:
    """Direct reference to an unboxed local in an ancestor frame."""

    __slots__ = ("frame", "index")

    def __init__(self, frame, index):
        self.frame = frame
        self.index = index


class Frame:
    __slots__ = ("info", "slots")

    def __init__(self, info, slots):
        self.info = info
        self.slots = slots


class Closure:
    __slots__ = ("info", "ups")

    def __init__(self, info, ups):
        self.info = info
        self.ups = ups  # list of Cell | FrameRef


def trunc_div(a, b, span):
    if b == 0:
        raise DivZero("integer division by zero", span=span)
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def trunc_mod(a, b, span):
    if b == 0:
        raise DivZero("integer modulo by zero", span=span)
    return a - trunc_div(a, b, span) * b


def eval_binop(op, left, right, span):
    if not isinstance(left, int) or not isinstance(right, int):
        raise TypeMismatch(
            f"operator {op!r} expects integers", span=span
        )
    if op == "+":
        return left + right
    if op == "-":
        return left - right
    if op == "*":
        return left * right
    if op == "/":
        return trunc_div(left, right, span)
    if op == "%":
        return trunc_mod(left, right, span)
    if op == "<":
        return 1 if left < right else 0
    if op == "<=":
        return 1 if left <= right else 0
    if op == ">":
        return 1 if left > right else 0
    if op == ">=":
        return 1 if left >= right else 0
    if op == "==":
        return 1 if left == right else 0
    if op == "!=":
        return 1 if left != right else 0
    raise AssertionError(f"unknown operator {op!r}")


def run(top):
    closure = Closure(top, [])
    frame = make_frame(top, [])
    return exec_block(frame, closure, top.body)


def make_frame(info, args):
    slots = [UNSET] * len(info.locals)
    for i, arg in enumerate(args):
        slots[i] = Cell(arg) if info.locals[i].boxed else arg
    return Frame(info, slots)


def make_closure(info, frame, closure):
    ups = []
    for up in info.upvalues:
        if up.kind == "local":
            if frame.info.locals[up.index].boxed:
                ups.append(frame.slots[up.index])  # share the cell
            else:
                ups.append(FrameRef(frame, up.index))
        else:
            ups.append(closure.ups[up.index])  # thread the parent's capture
    return Closure(info, ups)


def exec_block(frame, closure, block):
    value = 0
    for stmt in block.stmts:
        result = exec_stmt(frame, closure, stmt)
        if result is not None:
            value = result
    return value


def exec_stmt(frame, closure, stmt):
    if isinstance(stmt, ast.Let):
        local = frame.info.locals[stmt.slot]
        if isinstance(stmt.value, ast.FnLit):
            # pre-bind the slot so a recursive function can capture itself
            if local.boxed:
                cell = Cell(UNSET)
                frame.slots[stmt.slot] = cell
                cell.value = make_closure(stmt.value.info, frame, closure)
            else:
                frame.slots[stmt.slot] = UNSET
                frame.slots[stmt.slot] = make_closure(stmt.value.info, frame, closure)
        else:
            value = eval_expr(frame, closure, stmt.value)
            frame.slots[stmt.slot] = Cell(value) if local.boxed else value
        return None
    if isinstance(stmt, ast.Assign):
        value = eval_expr(frame, closure, stmt.value)
        write_var(frame, closure, stmt.res, value)
        return None
    if isinstance(stmt, ast.ExprStmt):
        return eval_expr(frame, closure, stmt.expr)
    raise AssertionError(f"unknown statement {stmt!r}")


def read_var(frame, closure, res, span):
    kind, index = res
    if kind == "local":
        slot = frame.slots[index]
        value = slot.value if frame.info.locals[index].boxed else slot
    else:
        ref = closure.ups[index]
        value = ref.value if isinstance(ref, Cell) else ref.frame.slots[ref.index]
    if value is UNSET:
        raise UninitializedVar("variable read before initialization", span=span)
    return value


def write_var(frame, closure, res, value):
    kind, index = res
    if kind == "local":
        if frame.info.locals[index].boxed:
            frame.slots[index].value = value
        else:
            frame.slots[index] = value
    else:
        ref = closure.ups[index]
        if isinstance(ref, Cell):
            ref.value = value
        else:
            ref.frame.slots[ref.index] = value


def eval_expr(frame, closure, expr):
    if isinstance(expr, ast.IntLit):
        return expr.value
    if isinstance(expr, ast.Var):
        return read_var(frame, closure, expr.res, expr.span)
    if isinstance(expr, ast.BinOp):
        left = eval_expr(frame, closure, expr.left)
        right = eval_expr(frame, closure, expr.right)
        return eval_binop(expr.op, left, right, expr.span)
    if isinstance(expr, ast.IfExpr):
        cond = eval_expr(frame, closure, expr.cond)
        branch = expr.then if cond != 0 else expr.otherwise
        return exec_block(frame, closure, branch)
    if isinstance(expr, ast.FnLit):
        return make_closure(expr.info, frame, closure)
    if isinstance(expr, ast.Call):
        callee = eval_expr(frame, closure, expr.callee)
        if not isinstance(callee, Closure):
            raise NotCallable("attempt to call a non-function value", span=expr.span)
        args = [eval_expr(frame, closure, arg) for arg in expr.args]
        if len(args) != callee.info.param_count:
            raise ArityError(
                f"expected {callee.info.param_count} arguments, got {len(args)}",
                span=expr.span,
            )
        new_frame = make_frame(callee.info, args)
        return exec_block(new_frame, callee, callee.info.body)
    raise AssertionError(f"unknown expression {expr!r}")
