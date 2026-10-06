"""Regular-expression AST over a finite alphabet.

Node kinds: ``lit`` (single character), ``eps`` (empty string), ``alt``
(union), ``cat`` (concatenation) and ``star`` (Kleene star).  Every node
carries a stable integer id assigned at construction time; ids survive
JSON serialisation round-trips unchanged.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

LIT, EPS, ALT, CAT, STAR = "lit", "eps", "alt", "cat", "star"
KINDS = (LIT, EPS, ALT, CAT, STAR)
_ARITY = {LIT: 0, EPS: 0, ALT: 2, CAT: 2, STAR: 1}


@dataclass(frozen=True)
class Node:
    id: int
    kind: str
    char: str | None = None
    children: tuple["Node", ...] = ()

    def __post_init__(self):
        if self.kind not in _ARITY:
            raise ValueError(f"unknown node kind {self.kind!r}")
        if len(self.children) != _ARITY[self.kind]:
            raise ValueError(f"{self.kind} expects {_ARITY[self.kind]} children")
        if self.kind == LIT and not (isinstance(self.char, str) and len(self.char) == 1):
            raise ValueError("lit node needs a single character")


class AstBuilder:
    """Builds AST nodes with stable, increasing ids."""

    def __init__(self, start: int = 0):
        self._next = start

    def _nid(self) -> int:
        nid = self._next
        self._next += 1
        return nid

    def lit(self, char: str) -> Node:
        return Node(self._nid(), LIT, char=char)

    def eps(self) -> Node:
        return Node(self._nid(), EPS)

    def alt(self, left: Node, right: Node) -> Node:
        return Node(self._nid(), ALT, children=(left, right))

    def cat(self, left: Node, right: Node) -> Node:
        return Node(self._nid(), CAT, children=(left, right))

    def star(self, child: Node) -> Node:
        return Node(self._nid(), STAR, children=(child,))


class _Parser:
    def __init__(self, text: str):
        self.text = text
        self.pos = 0
        self.b = AstBuilder()

    def _peek(self) -> str:
        i = self.pos
        while i < len(self.text) and self.text[i].isspace():
            i += 1
        return self.text[i] if i < len(self.text) else ""

    def _advance(self) -> None:
        while self.pos < len(self.text) and self.text[self.pos].isspace():
            self.pos += 1
        self.pos += 1

    def parse_alt(self) -> Node:
        node = self.parse_cat()
        while self._peek() == "|":
            self._advance()
            node = self.b.alt(node, self.parse_cat())
        return node

    def parse_cat(self) -> Node:
        items = []
        while self._peek() not in ("", ")", "|"):
            items.append(self.parse_rep())
        if not items:
            return self.b.eps()
        node = items[0]
        for item in items[1:]:
            node = self.b.cat(node, item)
        return node

    def parse_rep(self) -> Node:
        node = self.parse_atom()
        while self._peek() == "*":
            self._advance()
            node = self.b.star(node)
        return node

    def parse_atom(self) -> Node:
        c = self._peek()
        if c == "":
            raise SyntaxError("unexpected end of pattern")
        if c == "(":
            self._advance()
            node = self.parse_alt()
            if self._peek() != ")":
                raise SyntaxError("expected ')'")
            self._advance()
            return node
        if c == "ε":
            self._advance()
            return self.b.eps()
        if c == "\\":
            self._advance()
            c2 = self._peek()
            if c2 == "":
                raise SyntaxError("dangling backslash")
            self._advance()
            return self.b.lit(c2)
        if c in ")|*":
            raise SyntaxError(f"unexpected {c!r}")
        self._advance()
        return self.b.lit(c)


def parse_pattern(text: str) -> Node:
    """Parse a pattern string into an AST with stable ids.

    Syntax: literals, ``|``, juxtaposition, ``*``, parentheses, ``ε`` or
    ``()`` for the empty string, ``\\`` to escape metacharacters.
    """
    parser = _Parser(text)
    node = parser.parse_alt()
    if parser._peek() != "":
        raise SyntaxError(f"unexpected {parser._peek()!r} at offset {parser.pos}")
    return node


def ast_to_json(node: Node) -> dict:
    data = {"id": node.id, "kind": node.kind}
    if node.kind == LIT:
        data["char"] = node.char
    if node.children:
        data["children"] = [ast_to_json(c) for c in node.children]
    return data


def ast_from_json(data: dict) -> Node:
    if not isinstance(data, dict):
        raise ValueError("AST node must be an object")
    kind = data["kind"]
    nid = int(data["id"])
    if kind == LIT:
        return Node(nid, LIT, char=data["char"])
    if kind == EPS:
        return Node(nid, EPS)
    if kind in (ALT, CAT, STAR):
        children = tuple(ast_from_json(c) for c in data["children"])
        return Node(nid, kind, children=children)
    raise ValueError(f"unknown node kind {kind!r}")


def collect_nodes(root: Node) -> dict[int, Node]:
    nodes: dict[int, Node] = {}

    def visit(n: Node) -> None:
        if n.id in nodes:
            raise ValueError(f"duplicate node id {n.id}")
        nodes[n.id] = n
        for c in n.children:
            visit(c)

    visit(root)
    return nodes


def fingerprint(root: Node) -> str:
    canonical = json.dumps(ast_to_json(root), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
