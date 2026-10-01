"""Core type representations for hmtype."""

from __future__ import annotations


class Type:
    __slots__ = ()


class TInt(Type):
    __slots__ = ()

    def __repr__(self) -> str:
        return "int"


class TBool(Type):
    __slots__ = ()

    def __repr__(self) -> str:
        return "bool"


INT = TInt()
BOOL = TBool()


class TVar(Type):
    __slots__ = ("vid", "link")

    def __init__(self, vid: int):
        self.vid = vid
        self.link: Type | None = None

    def __repr__(self) -> str:
        return f"?v{self.vid}"


class TFun(Type):
    __slots__ = ("arg", "ret")

    def __init__(self, arg: Type, ret: Type):
        self.arg = arg
        self.ret = ret


class TTuple(Type):
    __slots__ = ("elems",)

    def __init__(self, elems: list[Type]):
        self.elems = elems


def prune(t: Type) -> Type:
    """Follow substitution links to the representative type."""
    while isinstance(t, TVar) and t.link is not None:
        t = t.link
    return t


class VarSupply:
    def __init__(self) -> None:
        self._next = 0

    def fresh(self) -> TVar:
        v = TVar(self._next)
        self._next += 1
        return v


def free_vars(t: Type, into: set[int] | None = None) -> set[int]:
    if into is None:
        into = set()
    t = prune(t)
    if isinstance(t, TVar):
        into.add(t.vid)
    elif isinstance(t, TFun):
        free_vars(t.arg, into)
        free_vars(t.ret, into)
    elif isinstance(t, TTuple):
        for e in t.elems:
            free_vars(e, into)
    return into


def _var_name(index: int) -> str:
    name = ""
    n = index
    while True:
        name = chr(ord("a") + n % 26) + name
        n = n // 26 - 1
        if n < 0:
            break
    return name


def type_str(t: Type) -> str:
    """Pretty-print a type; free variables are named a, b, c, ... in order
    of first appearance (left-to-right)."""
    names: dict[int, str] = {}

    def go(t: Type, prec: int) -> str:
        t = prune(t)
        if isinstance(t, TInt):
            return "int"
        if isinstance(t, TBool):
            return "bool"
        if isinstance(t, TVar):
            if t.vid not in names:
                names[t.vid] = _var_name(len(names))
            return names[t.vid]
        if isinstance(t, TFun):
            arg = go(t.arg, 1)
            ret = go(t.ret, 0)
            s = f"{arg} -> {ret}"
            return f"({s})" if prec > 0 else s
        if isinstance(t, TTuple):
            s = " * ".join(go(e, 2) for e in t.elems)
            return f"({s})"
        raise AssertionError(f"unknown type {t!r}")

    return go(t, 0)
