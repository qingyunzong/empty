"""Structural properties of regex ASTs used by the decision procedure."""
from __future__ import annotations

from functools import lru_cache

from .syntax import Node, LIT, EPS, ALT, CAT, STAR


@lru_cache(maxsize=None)
def nullable(node: Node) -> bool:
    if node.kind == LIT:
        return False
    if node.kind == EPS:
        return True
    if node.kind == ALT:
        return nullable(node.children[0]) or nullable(node.children[1])
    if node.kind == CAT:
        return nullable(node.children[0]) and nullable(node.children[1])
    return True  # star always matches the empty word


@lru_cache(maxsize=None)
def epsilon_parse_count(node: Node) -> int:
    """Number of distinct parse trees of the empty word, capped at 2.

    A star whose child is nullable has infinitely many empty-word parses
    (zero, one, two, ... empty repetitions) and is reported as 2.
    """
    if node.kind == LIT:
        return 0
    if node.kind == EPS:
        return 1
    if node.kind == ALT:
        return min(2, epsilon_parse_count(node.children[0])
                   + epsilon_parse_count(node.children[1]))
    if node.kind == CAT:
        return min(2, epsilon_parse_count(node.children[0])
                   * epsilon_parse_count(node.children[1]))
    return 2 if nullable(node.children[0]) else 1


@lru_cache(maxsize=None)
def firstpos(node: Node) -> frozenset:
    if node.kind == LIT:
        return frozenset({node.id})
    if node.kind == EPS:
        return frozenset()
    if node.kind == ALT:
        return firstpos(node.children[0]) | firstpos(node.children[1])
    if node.kind == CAT:
        left, right = node.children
        out = firstpos(left)
        if nullable(left):
            out = out | firstpos(right)
        return out
    return firstpos(node.children[0])


@lru_cache(maxsize=None)
def lastpos(node: Node) -> frozenset:
    if node.kind == LIT:
        return frozenset({node.id})
    if node.kind == EPS:
        return frozenset()
    if node.kind == ALT:
        return lastpos(node.children[0]) | lastpos(node.children[1])
    if node.kind == CAT:
        left, right = node.children
        out = lastpos(right)
        if nullable(right):
            out = out | lastpos(left)
        return out
    return lastpos(node.children[0])


def followpos(root: Node) -> dict:
    follow: dict[int, set] = {}

    def visit(node: Node) -> None:
        if node.kind == CAT:
            left, right = node.children
            for p in lastpos(left):
                follow.setdefault(p, set()).update(firstpos(right))
        elif node.kind == STAR:
            child = node.children[0]
            for p in lastpos(child):
                follow.setdefault(p, set()).update(firstpos(child))
        for c in node.children:
            visit(c)

    visit(root)
    return follow


def literals(root: Node) -> dict:
    """Map each literal node id (automaton position) to its character."""
    out: dict[int, str] = {}

    def visit(node: Node) -> None:
        if node.kind == LIT:
            out[node.id] = node.char
        for c in node.children:
            visit(c)

    visit(root)
    return out
