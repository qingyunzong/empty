"""Hindley-Milner type inference with let-polymorphism, the value
restriction, occurs check and error recovery.

Errors are accumulated (up to MAX_ERRORS per file) as JSON-able dicts;
after a unification failure the offending subterm is given a fresh type
variable so inference can continue and report further errors.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

from . import ast
from .types import (
    BOOL,
    INT,
    OccursError,
    TTuple,
    TFun,
    TVar,
    Type,
    UnifyMismatch,
    ftv,
    prune,
    show,
    unify,
)

MAX_ERRORS = 5

# op -> (left, right, result)
BINOPS: Dict[str, Tuple[Type, Type, Type]] = {
    "+": (INT, INT, INT),
    "-": (INT, INT, INT),
    "*": (INT, INT, INT),
    "<": (INT, INT, BOOL),
    ">": (INT, INT, BOOL),
    "<=": (INT, INT, BOOL),
    ">=": (INT, INT, BOOL),
    "=": (INT, INT, BOOL),
    "<>": (INT, INT, BOOL),
}


class Scheme:
    __slots__ = ("qvars", "ty")

    def __init__(self, qvars: List[TVar], ty: Type) -> None:
        self.qvars = qvars
        self.ty = ty


def is_value(node: ast.Node) -> bool:
    """Value restriction: only lambdas and literals may be generalised."""
    return isinstance(node, (ast.IntLit, ast.BoolLit, ast.Lam))


def ftv_env(env: Dict[str, Scheme]) -> List[TVar]:
    acc: List[TVar] = []
    for scheme in env.values():
        for var in ftv(scheme.ty):
            if var not in scheme.qvars and var not in acc:
                acc.append(var)
    return acc


def generalize(env: Dict[str, Scheme], ty: Type) -> Scheme:
    env_vars = ftv_env(env)
    qvars = [v for v in ftv(ty) if v not in env_vars]
    return Scheme(qvars, ty)


def instantiate(scheme: Scheme) -> Type:
    mapping: Dict[int, TVar] = {}

    def copy(t: Type) -> Type:
        t = prune(t)
        if isinstance(t, TVar):
            if t in scheme.qvars:
                if t.id not in mapping:
                    mapping[t.id] = TVar()
                return mapping[t.id]
            return t
        if isinstance(t, TFun):
            return TFun(copy(t.arg), copy(t.ret))
        if isinstance(t, TTuple):
            return TTuple(tuple(copy(e) for e in t.elems))
        return t

    return copy(scheme.ty)


def show_scheme(scheme: Scheme) -> str:
    return show(scheme.ty)


class _Abort(Exception):
    """Raised when the per-file error limit is reached."""


Env = Dict[str, Scheme]


class Inferencer:
    def __init__(self) -> None:
        self.errors: List[dict] = []

    # -- diagnostics -----------------------------------------------------
    def _push(self, err: dict) -> None:
        self.errors.append(err)
        if len(self.errors) >= MAX_ERRORS:
            raise _Abort()

    def _snapshot(self, env: Env) -> Dict[str, str]:
        return {name: show_scheme(scheme) for name, scheme in sorted(env.items())}

    def _unify_at(self, expected: Type, actual: Type, node: ast.Node, env: Env) -> None:
        """Unify an expected type with an actual (inferred) type.

        On mismatch the reported expected/actual follow these roles:
        unification preserves the call-side positions structurally, so
        the left side of UnifyMismatch always stems from `expected`.
        """
        try:
            unify(expected, actual)
        except OccursError as exc:
            self._push({
                "kind": "OccursError",
                "expected": show(exc.var),
                "actual": show(exc.typ),
                "span": node.span.to_json(),
                "env_snapshot": self._snapshot(env),
            })
        except UnifyMismatch as exc:
            self._push({
                "kind": "TypeError",
                "expected": show(exc.left),
                "actual": show(exc.right),
                "span": node.span.to_json(),
                "env_snapshot": self._snapshot(env),
            })

    # -- inference -------------------------------------------------------
    def infer(self, env: Env, node: ast.Node) -> Type:
        if isinstance(node, ast.IntLit):
            return INT
        if isinstance(node, ast.BoolLit):
            return BOOL
        if isinstance(node, ast.Var):
            scheme = env.get(node.name)
            if scheme is None:
                self._push({
                    "kind": "UnboundVar",
                    "expected": "bound variable",
                    "actual": node.name,
                    "span": node.span.to_json(),
                    "env_snapshot": self._snapshot(env),
                })
                return TVar()
            return instantiate(scheme)
        if isinstance(node, ast.Lam):
            param_ty = TVar()
            body_ty = self.infer({**env, node.param: Scheme([], param_ty)}, node.body)
            return TFun(param_ty, body_ty)
        if isinstance(node, ast.App):
            func_ty = self.infer(env, node.func)
            arg_ty = self.infer(env, node.arg)
            result_ty = TVar()
            self._unify_at(func_ty, TFun(arg_ty, result_ty), node, env)
            return result_ty
        if isinstance(node, ast.Let):
            value_ty = self.infer(env, node.value)
            if is_value(node.value):
                scheme = generalize(env, value_ty)
            else:
                scheme = Scheme([], value_ty)
            return self.infer({**env, node.name: scheme}, node.body)
        if isinstance(node, ast.If):
            cond_ty = self.infer(env, node.cond)
            self._unify_at(BOOL, cond_ty, node.cond, env)
            then_ty = self.infer(env, node.then)
            els_ty = self.infer(env, node.els)
            self._unify_at(then_ty, els_ty, node, env)
            return then_ty
        if isinstance(node, ast.Fix):
            param_ty = TVar()
            body_ty = self.infer({**env, node.param: Scheme([], param_ty)}, node.body)
            self._unify_at(param_ty, body_ty, node, env)
            return param_ty
        if isinstance(node, ast.BinOp):
            left_expected, right_expected, result_ty = BINOPS[node.op]
            left_ty = self.infer(env, node.left)
            self._unify_at(left_expected, left_ty, node, env)
            right_ty = self.infer(env, node.right)
            self._unify_at(right_expected, right_ty, node, env)
            return result_ty
        if isinstance(node, ast.TupleLit):
            return TTuple(tuple(self.infer(env, e) for e in node.elems))
        raise AssertionError(f"unknown node {node!r}")  # pragma: no cover


def infer_program(decls: List[Tuple[str, ast.Node]]) -> Tuple[List[Tuple[str, str]], List[dict]]:
    """Infer every top-level let; returns (results, errors)."""
    inferencer = Inferencer()
    env: Env = {}
    results: List[Tuple[str, str]] = []
    try:
        for name, expr in decls:
            ty = inferencer.infer(env, expr)
            if is_value(expr):
                env[name] = generalize(env, ty)
            else:
                env[name] = Scheme([], ty)
            results.append((name, show(ty)))
    except _Abort:
        pass
    return results, inferencer.errors
