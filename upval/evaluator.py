"""Cell-based evaluator.

Bindings flagged ``boxed`` by the escape analysis live in shared ``Cell``
objects; every closure capturing the same binding observes the same
cell, so assignments are mutually visible. Non-boxed bindings are plain
stack slots in the frame. Closures capture their defining frame, so
non-escaping inner functions can still read/write outer stack slots
while the frame is alive.
"""

from . import parser as ast
from .errors import UpvalRuntimeError

UNINIT = object()


class Cell:
    __slots__ = ("value",)

    def __init__(self, value=UNINIT):
        self.value = value


class Closure:
    __slots__ = ("fn", "env")

    def __init__(self, fn, env):
        self.fn = fn
        self.env = env


class Builtin:
    __slots__ = ("name", "arity", "func")

    def __init__(self, name, arity, func):
        self.name = name
        self.arity = arity
        self.func = func


class Frame:
    __slots__ = ("slots", "parent")

    def __init__(self, parent):
        self.slots = {}
        self.parent = parent


class ReturnSignal(Exception):
    def __init__(self, value):
        self.value = value


def format_value(value):
    if isinstance(value, bool) or isinstance(value, int):
        return str(value)
    if isinstance(value, Closure):
        return "<fn>"
    if isinstance(value, Builtin):
        return "<builtin>"
    return str(value)


class Evaluator:
    def __init__(self, out=None):
        self.out = out if out is not None else (lambda line: print(line))

    def run(self, program):
        frame = Frame(None)
        frame.slots["print"] = Builtin("print", 1, self._print)
        try:
            return self.exec_block(program.body, frame)
        except ReturnSignal as signal:
            return signal.value

    # ----- builtins -----------------------------------------------------

    def _print(self, value):
        if isinstance(value, bool) or not isinstance(value, int):
            raise UpvalRuntimeError(
                "TypeError", "print expects an integer argument"
            )
        self.out(str(value))
        return 0

    # ----- statements ---------------------------------------------------

    def exec_block(self, stmts, frame):
        last = 0
        for stmt in stmts:
            value = self.exec_stmt(stmt, frame)
            if isinstance(stmt, ast.ExprStmt):
                last = value
        return last

    def exec_stmt(self, stmt, frame):
        if isinstance(stmt, ast.Let):
            slot = Cell() if stmt.binding.boxed else UNINIT
            frame.slots[stmt.name] = slot
            value = self.eval_expr(stmt.value, frame)
            if stmt.binding.boxed:
                slot.value = value
            else:
                frame.slots[stmt.name] = value
            return value
        if isinstance(stmt, ast.Assign):
            value = self.eval_expr(stmt.value, frame)
            target = self._walk(frame, stmt.depth)
            if stmt.binding.boxed:
                target.slots[stmt.name].value = value
            else:
                target.slots[stmt.name] = value
            return value
        if isinstance(stmt, ast.Return):
            raise ReturnSignal(self.eval_expr(stmt.value, frame))
        if isinstance(stmt, ast.If):
            if self.eval_expr(stmt.cond, frame) != 0:
                return self.exec_block(stmt.then, frame)
            return self.exec_block(stmt.otherwise, frame)
        if isinstance(stmt, ast.ExprStmt):
            return self.eval_expr(stmt.expr, frame)
        raise AssertionError(f"unknown stmt {stmt!r}")  # pragma: no cover

    # ----- expressions --------------------------------------------------

    @staticmethod
    def _walk(frame, depth):
        for _ in range(depth):
            frame = frame.parent
        return frame

    def eval_expr(self, expr, frame):
        if isinstance(expr, ast.IntLit):
            return expr.value
        if isinstance(expr, ast.Var):
            target = self._walk(frame, expr.depth)
            slot = target.slots[expr.name]
            value = slot.value if isinstance(slot, Cell) else slot
            if value is UNINIT:
                raise UpvalRuntimeError(
                    "UninitializedVar",
                    f"variable '{expr.name}' read before initialization",
                    span=expr.span,
                    var=expr.name,
                )
            return value
        if isinstance(expr, ast.UnaryOp):
            operand = self.eval_expr(expr.operand, frame)
            self._check_int(operand, expr.span)
            return -operand
        if isinstance(expr, ast.BinOp):
            return self._eval_binop(expr, frame)
        if isinstance(expr, ast.FnLit):
            return Closure(expr, frame)
        if isinstance(expr, ast.Call):
            return self._eval_call(expr, frame)
        raise AssertionError(f"unknown expr {expr!r}")  # pragma: no cover

    @staticmethod
    def _check_int(value, span):
        if isinstance(value, bool) or not isinstance(value, int):
            raise UpvalRuntimeError(
                "TypeError",
                f"expected integer, got {format_value(value)}",
                span=span,
            )

    def _eval_binop(self, expr, frame):
        left = self.eval_expr(expr.left, frame)
        right = self.eval_expr(expr.right, frame)
        self._check_int(left, expr.left.span)
        self._check_int(right, expr.right.span)
        op = expr.op
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if op == "/":
            if right == 0:
                raise UpvalRuntimeError(
                    "DivByZero", "integer division by zero", span=expr.span
                )
            return left // right
        if op == "%":
            if right == 0:
                raise UpvalRuntimeError(
                    "DivByZero", "integer modulo by zero", span=expr.span
                )
            return left % right
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
        raise AssertionError(f"unknown op {op!r}")  # pragma: no cover

    def _eval_call(self, expr, frame):
        func = self.eval_expr(expr.func, frame)
        args = [self.eval_expr(arg, frame) for arg in expr.args]
        if isinstance(func, Builtin):
            if len(args) != func.arity:
                raise UpvalRuntimeError(
                    "ArityMismatch",
                    f"builtin '{func.name}' expects {func.arity} argument(s),"
                    f" got {len(args)}",
                    span=expr.span,
                )
            return func.func(*args)
        if isinstance(func, Closure):
            fn = func.fn
            if len(args) != len(fn.params):
                raise UpvalRuntimeError(
                    "ArityMismatch",
                    f"function expects {len(fn.params)} argument(s),"
                    f" got {len(args)}",
                    span=expr.span,
                )
            new_frame = Frame(func.env)
            for binding, value in zip(fn.param_bindings, args):
                if binding.boxed:
                    new_frame.slots[binding.name] = Cell(value)
                else:
                    new_frame.slots[binding.name] = value
            try:
                return self.exec_block(fn.body, new_frame)
            except ReturnSignal as signal:
                return signal.value
        raise UpvalRuntimeError(
            "NotCallable",
            f"value of type {type(func).__name__} is not callable",
            span=expr.span,
        )


def run(program, out=None):
    return Evaluator(out=out).run(program)
