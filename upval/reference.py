"""Explicit-environment reference interpreter.

Independent tree-walking implementation used to cross-check the
cell-based evaluator: closures capture a linked environment of plain
dictionaries, which naturally shares mutable bindings.
"""

from . import parser as ast
from .errors import UpvalRuntimeError

UNINIT = object()


class RefClosure:
    __slots__ = ("fn", "env")

    def __init__(self, fn, env):
        self.fn = fn
        self.env = env


class RefBuiltin:
    __slots__ = ("name", "arity", "func")

    def __init__(self, name, arity, func):
        self.name = name
        self.arity = arity
        self.func = func


class Env:
    __slots__ = ("vars", "parent")

    def __init__(self, parent):
        self.vars = {}
        self.parent = parent

    def lookup(self, name):
        env = self
        while env is not None:
            if name in env.vars:
                return env
            env = env.parent
        raise UpvalRuntimeError("FreeVar", f"undefined variable '{name}'")


class RefReturn(Exception):
    def __init__(self, value):
        self.value = value


class ReferenceInterpreter:
    def __init__(self, out=None):
        self.out = out if out is not None else (lambda line: print(line))

    def run(self, program):
        env = Env(None)
        env.vars["print"] = RefBuiltin("print", 1, self._print)
        try:
            return self.exec_block(program.body, env)
        except RefReturn as ret:
            return ret.value

    def _print(self, value):
        if isinstance(value, bool) or not isinstance(value, int):
            raise UpvalRuntimeError(
                "TypeError", "print expects an integer argument"
            )
        self.out(str(value))
        return 0

    def exec_block(self, stmts, env):
        last = 0
        for stmt in stmts:
            value = self.exec_stmt(stmt, env)
            if isinstance(stmt, ast.ExprStmt):
                last = value
        return last

    def exec_stmt(self, stmt, env):
        if isinstance(stmt, ast.Let):
            env.vars[stmt.name] = UNINIT
            value = self.eval_expr(stmt.value, env)
            env.vars[stmt.name] = value
            return value
        if isinstance(stmt, ast.Assign):
            value = self.eval_expr(stmt.value, env)
            env.lookup(stmt.name).vars[stmt.name] = value
            return value
        if isinstance(stmt, ast.Return):
            raise RefReturn(self.eval_expr(stmt.value, env))
        if isinstance(stmt, ast.If):
            if self.eval_expr(stmt.cond, env) != 0:
                return self.exec_block(stmt.then, env)
            return self.exec_block(stmt.otherwise, env)
        if isinstance(stmt, ast.ExprStmt):
            return self.eval_expr(stmt.expr, env)
        raise AssertionError(f"unknown stmt {stmt!r}")  # pragma: no cover

    def eval_expr(self, expr, env):
        if isinstance(expr, ast.IntLit):
            return expr.value
        if isinstance(expr, ast.Var):
            value = env.lookup(expr.name).vars[expr.name]
            if value is UNINIT:
                raise UpvalRuntimeError(
                    "UninitializedVar",
                    f"variable '{expr.name}' read before initialization",
                    span=expr.span,
                    var=expr.name,
                )
            return value
        if isinstance(expr, ast.UnaryOp):
            operand = self.eval_expr(expr.operand, env)
            self._check_int(operand, expr.span)
            return -operand
        if isinstance(expr, ast.BinOp):
            left = self.eval_expr(expr.left, env)
            right = self.eval_expr(expr.right, env)
            self._check_int(left, expr.left.span)
            self._check_int(right, expr.right.span)
            return self._apply(expr.op, left, right, expr.span)
        if isinstance(expr, ast.FnLit):
            return RefClosure(expr, env)
        if isinstance(expr, ast.Call):
            return self._eval_call(expr, env)
        raise AssertionError(f"unknown expr {expr!r}")  # pragma: no cover

    @staticmethod
    def _check_int(value, span):
        if isinstance(value, bool) or not isinstance(value, int):
            raise UpvalRuntimeError(
                "TypeError", "expected integer", span=span
            )

    @staticmethod
    def _apply(op, left, right, span):
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if op == "/":
            if right == 0:
                raise UpvalRuntimeError(
                    "DivByZero", "integer division by zero", span=span
                )
            return left // right
        if op == "%":
            if right == 0:
                raise UpvalRuntimeError(
                    "DivByZero", "integer modulo by zero", span=span
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

    def _eval_call(self, expr, env):
        func = self.eval_expr(expr.func, env)
        args = [self.eval_expr(arg, env) for arg in expr.args]
        if isinstance(func, RefBuiltin):
            if len(args) != func.arity:
                raise UpvalRuntimeError(
                    "ArityMismatch",
                    f"builtin '{func.name}' expects {func.arity} argument(s),"
                    f" got {len(args)}",
                    span=expr.span,
                )
            return func.func(*args)
        if isinstance(func, RefClosure):
            fn = func.fn
            if len(args) != len(fn.params):
                raise UpvalRuntimeError(
                    "ArityMismatch",
                    f"function expects {len(fn.params)} argument(s),"
                    f" got {len(args)}",
                    span=expr.span,
                )
            new_env = Env(func.env)
            for (pname, _), value in zip(fn.params, args):
                new_env.vars[pname] = value
            try:
                return self.exec_block(fn.body, new_env)
            except RefReturn as ret:
                return ret.value
        raise UpvalRuntimeError(
            "NotCallable", "value is not callable", span=expr.span
        )


def interpret(program, out=None):
    return ReferenceInterpreter(out=out).run(program)
