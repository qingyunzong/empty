"""Independent reference type checker used by the test-suite.

This is a deliberately separate implementation from hmtype.infer: a
textbook Algorithm W over immutable types with explicit substitutions
(no mutable links, no error recovery).  It implements the same value
restriction and occurs check so the randomised cross-validation test
can compare the two implementations.

Types are tuples:
    ("var", id) | ("const", name) | ("fun", a, b) | ("tuple", (t1, ...))
"""
from __future__ import annotations

import itertools
from typing import Dict, List, Tuple

from . import ast

Type = Tuple
Subst = Dict[int, Type]
Scheme = Tuple[List[int], Type]
Env = Dict[str, Scheme]

INT: Type = ("const", "int")
BOOL: Type = ("const", "bool")

BINOPS = {
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


class IllTyped(Exception):
    pass


def is_value(node: ast.Node) -> bool:
    return isinstance(node, (ast.IntLit, ast.BoolLit, ast.Lam))


def walk(t: Type, s: Subst) -> Type:
    while t[0] == "var" and t[1] in s:
        t = s[t[1]]
    return t


def occurs(i: int, t: Type, s: Subst) -> bool:
    t = walk(t, s)
    if t[0] == "var":
        return t[1] == i
    if t[0] == "fun":
        return occurs(i, t[1], s) or occurs(i, t[2], s)
    if t[0] == "tuple":
        return any(occurs(i, e, s) for e in t[1])
    return False


def unify(a: Type, b: Type, s: Subst) -> Subst:
    a = walk(a, s)
    b = walk(b, s)
    if a == b:
        return s
    if a[0] == "var":
        if occurs(a[1], b, s):
            raise IllTyped("occurs check failed")
        return {**s, a[1]: b}
    if b[0] == "var":
        if occurs(b[1], a, s):
            raise IllTyped("occurs check failed")
        return {**s, b[1]: a}
    if a[0] != b[0]:
        raise IllTyped(f"cannot unify {a} with {b}")
    if a[0] == "const":
        if a[1] != b[1]:
            raise IllTyped(f"cannot unify {a} with {b}")
        return s
    if a[0] == "fun":
        s = unify(a[1], b[1], s)
        return unify(a[2], b[2], s)
    if a[0] == "tuple":
        if len(a[1]) != len(b[1]):
            raise IllTyped("tuple arity mismatch")
        for x, y in zip(a[1], b[1]):
            s = unify(x, y, s)
        return s
    raise IllTyped("unknown type")  # pragma: no cover


def ftv(t: Type, s: Subst, acc: List[int]) -> List[int]:
    t = walk(t, s)
    if t[0] == "var":
        if t[1] not in acc:
            acc.append(t[1])
    elif t[0] == "fun":
        ftv(t[1], s, acc)
        ftv(t[2], s, acc)
    elif t[0] == "tuple":
        for e in t[1]:
            ftv(e, s, acc)
    return acc


def ftv_env(env: Env, s: Subst) -> List[int]:
    acc: List[int] = []
    for qvars, ty in env.values():
        for v in ftv(ty, s, []):
            if v not in qvars and v not in acc:
                acc.append(v)
    return acc


def instantiate(scheme: Scheme, s: Subst, gen) -> Type:
    qvars, ty = scheme
    mapping = {v: ("var", next(gen)) for v in qvars}

    def copy(t: Type) -> Type:
        t = walk(t, s)
        if t[0] == "var":
            return mapping.get(t[1], t)
        if t[0] == "fun":
            return ("fun", copy(t[1]), copy(t[2]))
        if t[0] == "tuple":
            return ("tuple", tuple(copy(e) for e in t[1]))
        return t

    return copy(ty)


def infer(env: Env, node: ast.Node, s: Subst, gen) -> Tuple[Subst, Type]:
    if isinstance(node, ast.IntLit):
        return s, INT
    if isinstance(node, ast.BoolLit):
        return s, BOOL
    if isinstance(node, ast.Var):
        if node.name not in env:
            raise IllTyped(f"unbound variable {node.name}")
        return s, instantiate(env[node.name], s, gen)
    if isinstance(node, ast.Lam):
        v: Type = ("var", next(gen))
        env2 = {**env, node.param: ([], v)}
        s, body = infer(env2, node.body, s, gen)
        return s, ("fun", v, body)
    if isinstance(node, ast.App):
        s, func = infer(env, node.func, s, gen)
        s, arg = infer(env, node.arg, s, gen)
        result: Type = ("var", next(gen))
        s = unify(func, ("fun", arg, result), s)
        return s, result
    if isinstance(node, ast.Let):
        s, value = infer(env, node.value, s, gen)
        if is_value(node.value):
            env_vars = ftv_env(env, s)
            qvars = [v for v in ftv(value, s, []) if v not in env_vars]
        else:
            qvars = []
        env2 = {**env, node.name: (qvars, value)}
        return infer(env2, node.body, s, gen)
    if isinstance(node, ast.If):
        s, cond = infer(env, node.cond, s, gen)
        s = unify(cond, BOOL, s)
        s, then = infer(env, node.then, s, gen)
        s, els = infer(env, node.els, s, gen)
        s = unify(then, els, s)
        return s, then
    if isinstance(node, ast.Fix):
        v: Type = ("var", next(gen))
        env2 = {**env, node.param: ([], v)}
        s, body = infer(env2, node.body, s, gen)
        s = unify(v, body, s)
        return s, v
    if isinstance(node, ast.BinOp):
        left_t, right_t, result = BINOPS[node.op]
        s, left = infer(env, node.left, s, gen)
        s = unify(left, left_t, s)
        s, right = infer(env, node.right, s, gen)
        s = unify(right, right_t, s)
        return s, result
    if isinstance(node, ast.TupleLit):
        elems = []
        for e in node.elems:
            s, ty = infer(env, e, s, gen)
            elems.append(ty)
        return s, ("tuple", tuple(elems))
    raise AssertionError(f"unknown node {node!r}")  # pragma: no cover


def format_type(t: Type, s: Subst) -> str:
    """Render a type exactly like hmtype.types.show (a, b, c, ...)."""
    names: Dict[int, str] = {}

    def go(t: Type, prec: int) -> str:
        t = walk(t, s)
        if t[0] == "var":
            if t[1] not in names:
                i = len(names)
                names[t[1]] = chr(ord("a") + i % 26) + (str(i // 26) if i >= 26 else "")
            return names[t[1]]
        if t[0] == "const":
            return t[1]
        if t[0] == "fun":
            out = go(t[1], 1) + " -> " + go(t[2], 0)
            return f"({out})" if prec > 0 else out
        if t[0] == "tuple":
            return "(" + ", ".join(go(e, 0) for e in t[1]) + ")"
        raise AssertionError  # pragma: no cover

    return go(t, 0)


def infer_closed(node: ast.Node) -> str:
    """Infer a closed term; returns the formatted type or raises IllTyped."""
    gen = itertools.count()
    s, ty = infer({}, node, {}, gen)
    return format_type(ty, s)
