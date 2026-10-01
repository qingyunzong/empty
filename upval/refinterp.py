"""Reference interpreter with explicit chained environments.

Used as the semantic ground truth for differential testing against the
cell/stack-slot interpreter in ``interp.py``.
"""

from . import parser as ast
from .errors import ArityError, NotCallable
from .interp import eval_binop


class Env:
    __slots__ = ("vars", "parent")

    def __init__(self, parent):
        self.vars = {}
        self.parent = parent


class RefClosure:
    __slots__ = ("node", "env")

    def __init__(self, node, env):
        self.node = node
        self.env = env


def run(top):
    return eval_block(top.body, Env(None))


def eval_block(block, env):
    value = 0
    for stmt in block.stmts:
        if isinstance(stmt, ast.Let):
            env.vars[stmt.name] = eval_expr(stmt.value, env)
        elif isinstance(stmt, ast.Assign):
            assign(stmt.name, eval_expr(stmt.value, env), env)
        elif isinstance(stmt, ast.ExprStmt):
            value = eval_expr(stmt.expr, env)
        else:
            raise AssertionError(f"unknown statement {stmt!r}")
    return value


def lookup(name, env):
    while env is not None:
        if name in env.vars:
            return env.vars[name]
        env = env.parent
    raise AssertionError(f"resolver missed variable {name!r}")


def assign(name, value, env):
    while env is not None:
        if name in env.vars:
            env.vars[name] = value
            return
        env = env.parent
    raise AssertionError(f"resolver missed variable {name!r}")


def eval_expr(expr, env):
    if isinstance(expr, ast.IntLit):
        return expr.value
    if isinstance(expr, ast.Var):
        return lookup(expr.name, env)
    if isinstance(expr, ast.BinOp):
        left = eval_expr(expr.left, env)
        right = eval_expr(expr.right, env)
        return eval_binop(expr.op, left, right, expr.span)
    if isinstance(expr, ast.IfExpr):
        cond = eval_expr(expr.cond, env)
        branch = expr.then if cond != 0 else expr.otherwise
        return eval_block(branch, env)
    if isinstance(expr, ast.FnLit):
        return RefClosure(expr, env)
    if isinstance(expr, ast.Call):
        callee = eval_expr(expr.callee, env)
        if not isinstance(callee, RefClosure):
            raise NotCallable("attempt to call a non-function value", span=expr.span)
        args = [eval_expr(arg, env) for arg in expr.args]
        params = callee.node.params
        if len(args) != len(params):
            raise ArityError(
                f"expected {len(params)} arguments, got {len(args)}",
                span=expr.span,
            )
        call_env = Env(callee.env)
        for (pname, _), arg in zip(params, args):
            call_env.vars[pname] = arg
        return eval_block(callee.node.body, call_env)
    raise AssertionError(f"unknown expression {expr!r}")
