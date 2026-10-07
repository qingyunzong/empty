"""Regular-expression AST over a finite alphabet.

Node kinds: literal, epsilon (empty string), union, concatenation and star.
Every node carries a stable, unique integer id.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterator, List, Tuple


class AstError(ValueError):
    """Raised for malformed ASTs."""


@dataclass(frozen=True)
class Node:
    id: int


@dataclass(frozen=True)
class Lit(Node):
    char: str


@dataclass(frozen=True)
class Eps(Node):
    pass


@dataclass(frozen=True)
class Union(Node):
    children: Tuple["Node", ...]


@dataclass(frozen=True)
class Cat(Node):
    children: Tuple["Node", ...]


@dataclass(frozen=True)
class Star(Node):
    child: "Node"


class Builder:
    """Constructs AST nodes while assigning stable, unique ids."""

    def __init__(self, start: int = 1):
        self._next = start - 1

    def _nid(self) -> int:
        self._next += 1
        return self._next

    def lit(self, char: str) -> Lit:
        if not isinstance(char, str) or len(char) != 1:
            raise AstError("literal must be a single character")
        return Lit(self._nid(), char)

    def eps(self) -> Eps:
        return Eps(self._nid())

    def union(self, *children: Node) -> Union:
        return Union(self._nid(), tuple(children))

    def cat(self, *children: Node) -> Cat:
        return Cat(self._nid(), tuple(children))

    def star(self, child: Node) -> Star:
        return Star(self._nid(), child)


def iter_nodes(root: Node) -> Iterator[Node]:
    stack = [root]
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (Union, Cat)):
            stack.extend(reversed(node.children))
        elif isinstance(node, Star):
            stack.append(node.child)


def index_by_id(root: Node) -> Dict[int, Node]:
    idx: Dict[int, Node] = {}
    for node in iter_nodes(root):
        if node.id in idx:
            raise AstError(f"duplicate node id {node.id}")
        idx[node.id] = node
    return idx


def validate(root: Node) -> None:
    idx = index_by_id(root)
    for node in idx.values():
        if isinstance(node, Lit):
            if not isinstance(node.char, str) or len(node.char) != 1:
                raise AstError("literal char must be a single character")
        elif isinstance(node, Union):
            if not node.children:
                raise AstError("union needs at least one child")
        elif isinstance(node, (Eps, Cat, Star)):
            pass
        else:
            raise AstError(f"unknown node {node!r}")


def compute_nullable(root: Node) -> Dict[int, bool]:
    memo: Dict[int, bool] = {}

    def nullable(node: Node) -> bool:
        if node.id in memo:
            return memo[node.id]
        if isinstance(node, Lit):
            res = False
        elif isinstance(node, Eps):
            res = True
        elif isinstance(node, Union):
            res = any(nullable(c) for c in node.children)
        elif isinstance(node, Cat):
            res = all(nullable(c) for c in node.children)
        elif isinstance(node, Star):
            res = True
        else:
            raise AstError(f"unknown node {node!r}")
        memo[node.id] = res
        return res

    for n in iter_nodes(root):
        nullable(n)
    return memo


def compute_minword(root: Node) -> Dict[int, str]:
    """Shortest derivable word per node; lexicographically smallest on ties."""
    memo: Dict[int, str] = {}

    def minword(node: Node) -> str:
        if node.id in memo:
            return memo[node.id]
        if isinstance(node, Lit):
            res = node.char
        elif isinstance(node, Eps):
            res = ""
        elif isinstance(node, Union):
            res = min((minword(c) for c in node.children), key=lambda w: (len(w), w))
        elif isinstance(node, Cat):
            res = "".join(minword(c) for c in node.children)
        elif isinstance(node, Star):
            res = ""
        else:
            raise AstError(f"unknown node {node!r}")
        memo[node.id] = res
        return res

    for n in iter_nodes(root):
        minword(n)
    return memo


def alphabet(root: Node) -> List[str]:
    return sorted({n.char for n in iter_nodes(root) if isinstance(n, Lit)})


def contains_id(node: Node, nid: int) -> bool:
    return any(n.id == nid for n in iter_nodes(node))


# ---------- JSON ----------

def to_json(node: Node) -> dict:
    if isinstance(node, Lit):
        return {"type": "lit", "id": node.id, "char": node.char}
    if isinstance(node, Eps):
        return {"type": "eps", "id": node.id}
    if isinstance(node, Union):
        return {"type": "union", "id": node.id,
                "children": [to_json(c) for c in node.children]}
    if isinstance(node, Cat):
        return {"type": "cat", "id": node.id,
                "children": [to_json(c) for c in node.children]}
    if isinstance(node, Star):
        return {"type": "star", "id": node.id, "child": to_json(node.child)}
    raise AstError(f"unknown node {node!r}")


def from_json(data: dict) -> Node:
    counter = [0]

    def auto_id() -> int:
        counter[0] += 1
        return counter[0]

    def build(d: dict) -> Node:
        if not isinstance(d, dict):
            raise AstError("node must be an object")
        nid = d.get("id")
        if nid is None:
            nid = auto_id()
        if not isinstance(nid, int) or isinstance(nid, bool):
            raise AstError("id must be an integer")
        t = d.get("type")
        if t == "lit":
            char = d.get("char")
            if not isinstance(char, str) or len(char) != 1:
                raise AstError("lit node needs a single-character 'char'")
            return Lit(nid, char)
        if t == "eps":
            return Eps(nid)
        if t == "union":
            return Union(nid, tuple(build(c) for c in d.get("children", [])))
        if t == "cat":
            return Cat(nid, tuple(build(c) for c in d.get("children", [])))
        if t == "star":
            if "child" not in d:
                raise AstError("star node needs a 'child'")
            return Star(nid, build(d["child"]))
        raise AstError(f"unknown node type {t!r}")

    root = build(data)
    validate(root)
    return root
