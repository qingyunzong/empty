"""Type representation, unification (with occurs check) and pretty printing."""
from __future__ import annotations

import itertools
from typing import Dict, List, Tuple

_ids = itertools.count()


class Type:
    __slots__ = ()


class TVar(Type):
    __slots__ = ("id", "link")

    def __init__(self) -> None:
        self.id = next(_ids)
        self.link: Type | None = None

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"TVar({self.id})"


class TConst(Type):
    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name


class TFun(Type):
    __slots__ = ("arg", "ret")

    def __init__(self, arg: Type, ret: Type) -> None:
        self.arg = arg
        self.ret = ret


class TTuple(Type):
    __slots__ = ("elems",)

    def __init__(self, elems: Tuple[Type, ...]) -> None:
        self.elems = elems


INT = TConst("int")
BOOL = TConst("bool")


class UnifyError(Exception):
    """Base class for unification failures."""


class UnifyMismatch(UnifyError):
    """Carries the two unifiable sides in the order unify was called:
    `left` is the expected side, `right` the actual side."""

    def __init__(self, left: Type, right: Type) -> None:
        super().__init__("type mismatch")
        self.left = left
        self.right = right


class OccursError(UnifyError):
    def __init__(self, var: TVar, typ: Type) -> None:
        super().__init__("occurs check failed")
        self.var = var
        self.typ = typ


def prune(t: Type) -> Type:
    while isinstance(t, TVar) and t.link is not None:
        t = t.link
    return t


def occurs(var: TVar, t: Type) -> bool:
    t = prune(t)
    if t is var:
        return True
    if isinstance(t, TFun):
        return occurs(var, t.arg) or occurs(var, t.ret)
    if isinstance(t, TTuple):
        return any(occurs(var, e) for e in t.elems)
    return False


def unify(a: Type, b: Type) -> None:
    a = prune(a)
    b = prune(b)
    if a is b:
        return
    if isinstance(a, TVar):
        if occurs(a, b):
            raise OccursError(a, b)
        a.link = b
        return
    if isinstance(b, TVar):
        if occurs(b, a):
            raise OccursError(b, a)
        b.link = a
        return
    if type(a) is not type(b):
        raise UnifyMismatch(a, b)
    if isinstance(a, TConst):
        if a.name != b.name:  # type: ignore[union-attr]
            raise UnifyMismatch(a, b)
        return
    if isinstance(a, TFun) and isinstance(b, TFun):
        unify(a.arg, b.arg)
        unify(a.ret, b.ret)
        return
    if isinstance(a, TTuple) and isinstance(b, TTuple):
        if len(a.elems) != len(b.elems):
            raise UnifyMismatch(a, b)
        for x, y in zip(a.elems, b.elems):
            unify(x, y)
        return


def ftv(t: Type, acc: List[TVar] | None = None) -> List[TVar]:
    """Free (unlinked) type variables, in left-to-right appearance order."""
    if acc is None:
        acc = []
    t = prune(t)
    if isinstance(t, TVar):
        if t not in acc:
            acc.append(t)
    elif isinstance(t, TFun):
        ftv(t.arg, acc)
        ftv(t.ret, acc)
    elif isinstance(t, TTuple):
        for e in t.elems:
            ftv(e, acc)
    return acc


def var_name(i: int) -> str:
    return chr(ord("a") + i % 26) + (str(i // 26) if i >= 26 else "")


def show(t: Type) -> str:
    """Render a type, naming free variables a, b, c, ... in appearance order."""
    return _show(prune(t), {}, 0)


def _show(t: Type, names: Dict[TVar, str], prec: int) -> str:
    t = prune(t)
    if isinstance(t, TVar):
        if t not in names:
            names[t] = var_name(len(names))
        return names[t]
    if isinstance(t, TConst):
        return t.name
    if isinstance(t, TFun):
        s = _show(t.arg, names, 1) + " -> " + _show(t.ret, names, 0)
        return f"({s})" if prec > 0 else s
    if isinstance(t, TTuple):
        return "(" + ", ".join(_show(e, names, 0) for e in t.elems) + ")"
    raise AssertionError("unknown type")  # pragma: no cover
