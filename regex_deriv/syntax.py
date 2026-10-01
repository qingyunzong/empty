"""Hash-consed regular expression AST with normalizing smart constructors.

Every node is interned: structurally identical expressions are the *same*
object, so derivative caches and visited sets can rely on identity.  The
smart constructors (union/inter/concat/star/compl/char) enforce the
following normalization rules, which make the set of Brzozowski
derivatives finite (termination of the symbolic automaton construction):

  union / inter : associative-commutative-idempotent (children flattened,
                  sorted by a structural key, duplicates removed)
  union(x, empty)        = x            inter(x, ALL)  = x
  union(x, ALL)          = ALL          inter(x, empty) = empty
  union(x, ~x)           = ALL          inter(x, ~x)    = empty
  concat                 : associative (flattened)
  concat(x, eps)         = x            concat(x, empty) = empty
  star(star(x))          = star(x)
  star(empty) = star(eps) = eps
  compl(compl(x))        = x

Tests in tests/test_checker.py prove (by exhaustive enumeration against an
independent Thompson-construction engine) that these rewritings preserve
the accepted language.
"""
from __future__ import annotations

TAG_RANK = {
    "empty": 0, "eps": 1, "char": 2, "compl": 3,
    "star": 4, "concat": 5, "inter": 6, "union": 7,
}


class Node:
    """An interned, immutable regular expression node."""

    __slots__ = ("tag", "args", "_hash", "_nullable", "_key")
    _intern: dict = {}

    def __new__(cls, tag, args=()):
        key = (tag, args)
        node = cls._intern.get(key)
        if node is None:
            node = super().__new__(cls)
            node.tag = tag
            node.args = args
            node._hash = hash(key)
            node._nullable = None
            node._key = None
            cls._intern[key] = node
        return node

    def __hash__(self):
        return self._hash

    def __eq__(self, other):
        return self is other

    def __ne__(self, other):
        return self is not other

    def __repr__(self):
        return f"Node({to_str(self)})"


EMPTY = Node("empty")
EPS = Node("eps")


def sort_key(node):
    """Deterministic structural ordering key (cached per node)."""
    if node._key is None:
        node._key = (
            TAG_RANK[node.tag],
            tuple(sort_key(a) if isinstance(a, Node) else a for a in node.args),
        )
    return node._key


def char(lo, hi):
    """Character range [lo, hi] (inclusive code points)."""
    lo, hi = int(lo), int(hi)
    if lo > hi:
        return EMPTY
    return Node("char", (lo, hi))


def compl(x):
    if x.tag == "compl":
        return x.args[0]
    return Node("compl", (x,))


ALL = compl(EMPTY)  # the universal language (over any alphabet)


def star(x):
    if x.tag in ("empty", "eps"):
        return EPS
    if x.tag == "star":
        return x
    return Node("star", (x,))


def concat(*xs):
    flat = []
    for x in xs:
        if x.tag == "empty":
            return EMPTY
        if x.tag == "concat":
            flat.extend(x.args)
        elif x.tag != "eps":
            flat.append(x)
    if not flat:
        return EPS
    if len(flat) == 1:
        return flat[0]
    return Node("concat", tuple(flat))


def union(*xs):
    flat = set()
    for x in xs:
        if x.tag == "union":
            flat.update(x.args)
        elif x.tag != "empty":
            flat.add(x)
    if not flat:
        return EMPTY
    if ALL in flat:
        return ALL
    for x in flat:
        if x.tag == "compl" and x.args[0] in flat:
            return ALL
    if len(flat) == 1:
        return next(iter(flat))
    return Node("union", tuple(sorted(flat, key=sort_key)))


def inter(*xs):
    flat = set()
    for x in xs:
        if x.tag == "empty":
            return EMPTY
        if x.tag == "inter":
            flat.update(x.args)
        elif x is not ALL:
            flat.add(x)
    if not flat:
        return ALL
    for x in flat:
        if x.tag == "compl" and x.args[0] in flat:
            return EMPTY
    if len(flat) == 1:
        return next(iter(flat))
    return Node("inter", tuple(sorted(flat, key=sort_key)))


def nullable(node):
    """Does the expression accept the empty string? (cached per node)"""
    if node._nullable is None:
        t = node.tag
        if t == "empty":
            r = False
        elif t == "eps":
            r = True
        elif t == "char":
            r = False
        elif t == "concat":
            r = all(nullable(a) for a in node.args)
        elif t == "union":
            r = any(nullable(a) for a in node.args)
        elif t == "inter":
            r = all(nullable(a) for a in node.args)
        elif t == "compl":
            r = not nullable(node.args[0])
        elif t == "star":
            r = True
        else:  # pragma: no cover
            raise AssertionError(t)
        node._nullable = r
    return node._nullable


def char_ranges(node, acc=None):
    """All (lo, hi) ranges of char nodes occurring in the expression."""
    if acc is None:
        acc = set()
    if node.tag == "char":
        acc.add(node.args)
    else:
        for a in node.args:
            if isinstance(a, Node):
                char_ranges(a, acc)
    return acc


# ---------------------------------------------------------------- raw AST

def from_raw(raw):
    """Build a normalized, interned Node from a raw parser tree (tuples)."""
    tag = raw[0]
    if tag == "empty":
        return EMPTY
    if tag == "eps":
        return EPS
    if tag == "char":
        return char(raw[1], raw[2])
    if tag == "compl":
        return compl(from_raw(raw[1]))
    if tag == "star":
        return star(from_raw(raw[1]))
    if tag == "concat":
        return concat(*(from_raw(x) for x in raw[1:]))
    if tag == "union":
        return union(*(from_raw(x) for x in raw[1:]))
    if tag == "inter":
        return inter(*(from_raw(x) for x in raw[1:]))
    raise ValueError(f"unknown raw node: {tag!r}")


# ------------------------------------------------------- JSON serialization

def to_json(node):
    t = node.tag
    if t == "empty":
        return "empty"
    if t == "eps":
        return "eps"
    if t == "char":
        return ["char", node.args[0], node.args[1]]
    return [t] + [to_json(a) for a in node.args]


def from_json(j):
    if j == "empty":
        return EMPTY
    if j == "eps":
        return EPS
    tag = j[0]
    if tag == "char":
        return char(j[1], j[2])
    if tag == "compl":
        return compl(from_json(j[1]))
    if tag == "star":
        return star(from_json(j[1]))
    if tag == "concat":
        return concat(*(from_json(x) for x in j[1:]))
    if tag == "union":
        return union(*(from_json(x) for x in j[1:]))
    if tag == "inter":
        return inter(*(from_json(x) for x in j[1:]))
    raise ValueError(f"unknown node tag: {tag!r}")


def to_str(node):
    t = node.tag
    if t == "empty":
        return "∅"
    if t == "eps":
        return "ε"
    if t == "char":
        lo, hi = node.args
        if lo == hi:
            return repr(chr(lo))
        return f"[{chr(lo)!r}-{chr(hi)!r}]"
    return "(" + t + " " + " ".join(to_str(a) for a in node.args) + ")"
