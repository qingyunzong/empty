"""Hindley-Milner type inference with let-polymorphism, the value
restriction, an occurs check, and per-top-level-let error recovery."""

from __future__ import annotations

from .errors import (HMError, OccursError, Span, TypeMismatch,
                     UnboundVariable)
from .syntax import (ARITH_OPS, EQ_OPS, App, BinOp, BoolLit, Fix, If, IntLit,
                     Lam, Let, Node, TopLet, Tuple, Var)
from .types import (BOOL, INT, TBool, TFun, TInt, TTuple, TVar, Type,
                    VarSupply, free_vars, prune, type_str)

MAX_ERRORS = 5


class Scheme:
    __slots__ = ("qvars", "ty")

    def __init__(self, qvars: set[int], ty: Type):
        self.qvars = qvars
        self.ty = ty


Env = dict[str, Scheme]


def snapshot_env(env: Env) -> dict[str, str]:
    return {name: type_str(sc.ty) for name, sc in env.items()}


def is_value(node: Node) -> bool:
    """Value restriction: only lambdas and literals are generalizable."""
    return isinstance(node, (Lam, IntLit, BoolLit))


class Infer:
    def __init__(self) -> None:
        self.supply = VarSupply()

    # ---------------------------------------------------------- schemes

    def instantiate(self, sc: Scheme) -> Type:
        if not sc.qvars:
            return sc.ty
        mapping: dict[int, TVar] = {}

        def go(t: Type) -> Type:
            t = prune(t)
            if isinstance(t, TVar):
                if t.vid in sc.qvars:
                    if t.vid not in mapping:
                        mapping[t.vid] = self.supply.fresh()
                    return mapping[t.vid]
                return t
            if isinstance(t, TFun):
                return TFun(go(t.arg), go(t.ret))
            if isinstance(t, TTuple):
                return TTuple([go(e) for e in t.elems])
            return t

        return go(sc.ty)

    def generalize(self, env: Env, ty: Type) -> Scheme:
        env_fvs: set[int] = set()
        for sc in env.values():
            fvs = free_vars(sc.ty)
            env_fvs |= (fvs - sc.qvars)
        qvars = free_vars(ty) - env_fvs
        return Scheme(qvars, ty)

    # ---------------------------------------------------------- unification

    def _occurs(self, vid: int, t: Type) -> bool:
        t = prune(t)
        if isinstance(t, TVar):
            return t.vid == vid
        if isinstance(t, TFun):
            return self._occurs(vid, t.arg) or self._occurs(vid, t.ret)
        if isinstance(t, TTuple):
            return any(self._occurs(vid, e) for e in t.elems)
        return False

    def unify(self, expected: Type, actual: Type, span: Span, env: Env) -> None:
        expected = prune(expected)
        actual = prune(actual)
        if expected is actual:
            return
        if isinstance(expected, TVar):
            self._bind(expected, actual, span, env)
            return
        if isinstance(actual, TVar):
            self._bind(actual, expected, span, env)
            return
        if isinstance(expected, (TInt, TBool)) and type(expected) is type(actual):
            return
        if isinstance(expected, TFun) and isinstance(actual, TFun):
            self.unify(expected.arg, actual.arg, span, env)
            self.unify(expected.ret, actual.ret, span, env)
            return
        if isinstance(expected, TTuple) and isinstance(actual, TTuple) \
                and len(expected.elems) == len(actual.elems):
            for e1, e2 in zip(expected.elems, actual.elems):
                self.unify(e1, e2, span, env)
            return
        raise TypeMismatch(type_str(expected), type_str(actual), span,
                           snapshot_env(env))

    def _bind(self, var: TVar, ty: Type, span: Span, env: Env) -> None:
        if self._occurs(var.vid, ty):
            raise OccursError(type_str(var), type_str(ty), span,
                              snapshot_env(env))
        var.link = ty

    # ---------------------------------------------------------- inference

    def infer(self, env: Env, node: Node) -> Type:
        if isinstance(node, IntLit):
            return INT
        if isinstance(node, BoolLit):
            return BOOL
        if isinstance(node, Var):
            sc = env.get(node.name)
            if sc is None:
                raise UnboundVariable(node.name, node.span, snapshot_env(env))
            return self.instantiate(sc)
        if isinstance(node, Lam):
            param_ty = self.supply.fresh()
            env2 = dict(env)
            env2[node.param] = Scheme(set(), param_ty)
            body_ty = self.infer(env2, node.body)
            return TFun(param_ty, body_ty)
        if isinstance(node, App):
            fn_ty = self.infer(env, node.fn)
            arg_ty = self.infer(env, node.arg)
            ret_ty = self.supply.fresh()
            self.unify(fn_ty, TFun(arg_ty, ret_ty), node.span, env)
            return ret_ty
        if isinstance(node, Let):
            rhs_ty = self.infer(env, node.rhs)
            if is_value(node.rhs):
                sc = self.generalize(env, rhs_ty)
            else:
                sc = Scheme(set(), rhs_ty)
            env2 = dict(env)
            env2[node.name] = sc
            return self.infer(env2, node.body)
        if isinstance(node, If):
            cond_ty = self.infer(env, node.cond)
            self.unify(BOOL, cond_ty, node.cond.span, env)
            then_ty = self.infer(env, node.then)
            els_ty = self.infer(env, node.els)
            self.unify(then_ty, els_ty, node.span, env)
            return then_ty
        if isinstance(node, Fix):
            ty = self.infer(env, node.expr)
            a = self.supply.fresh()
            self.unify(ty, TFun(a, a), node.span, env)
            return a
        if isinstance(node, BinOp):
            left_ty = self.infer(env, node.left)
            right_ty = self.infer(env, node.right)
            if node.op in ARITH_OPS:
                self.unify(INT, left_ty, node.left.span, env)
                self.unify(INT, right_ty, node.right.span, env)
                return INT
            if node.op in EQ_OPS:
                self.unify(left_ty, right_ty, node.span, env)
                return BOOL
            self.unify(INT, left_ty, node.left.span, env)
            self.unify(INT, right_ty, node.right.span, env)
            return BOOL
        if isinstance(node, Tuple):
            return TTuple([self.infer(env, e) for e in node.elems])
        raise AssertionError(f"unknown node {node!r}")


def infer_expr(node: Node) -> Type:
    """Infer the principal type of a closed expression AST."""
    return Infer().infer({}, node)


def infer_program(lets: list[TopLet]) -> list[tuple[str, str | None, HMError | None]]:
    """Infer each top-level let. Returns one entry per processed let:
    (name, type_string, None) on success or (name, None, error) on failure.
    Stops after MAX_ERRORS errors."""
    engine = Infer()
    env: Env = {}
    entries: list[tuple[str, str | None, HMError | None, Scheme | None]] = []
    errors = 0
    for tl in lets:
        try:
            ty = engine.infer(env, tl.rhs)
            if is_value(tl.rhs):
                sc = engine.generalize(env, ty)
            else:
                sc = Scheme(set(), ty)
            env[tl.name] = sc
            entries.append((tl.name, None, None, sc))
        except HMError as e:
            errors += 1
            entries.append((tl.name, None, e, None))
            if errors >= MAX_ERRORS:
                break
    # Resolve type strings only after all inference, so earlier types
    # reflect any later unifications of non-generalized bindings.
    result: list[tuple[str, str | None, HMError | None]] = []
    for name, _, err, sc in entries:
        if err is not None:
            result.append((name, None, err))
        else:
            result.append((name, type_str(sc.ty), None))
    return result
