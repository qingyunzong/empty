"""Parse trees and an independent parse-tree verifier.

A parse tree records, for every AST node it uses, the consumed interval
``[start, end)`` of the word and the child trees.  Two parses of the same
word are considered different exactly when their trees differ in node
selection or in a consumption interval -- never merely because an
automaton reached the same character state through another path.
"""
from __future__ import annotations

from dataclasses import dataclass

from .syntax import LIT, EPS, ALT, CAT, STAR


@dataclass(frozen=True)
class Tree:
    node: int
    start: int
    end: int
    children: tuple["Tree", ...] = ()


def shift(tree: Tree, delta: int) -> Tree:
    """Move a tree's intervals by ``delta`` (used when embedding parses)."""
    if delta == 0:
        return tree
    return Tree(tree.node, tree.start + delta, tree.end + delta,
                tuple(shift(c, delta) for c in tree.children))


def tree_to_json(tree: Tree) -> dict:
    data = {"node": tree.node, "span": [tree.start, tree.end]}
    if tree.children:
        data["children"] = [tree_to_json(c) for c in tree.children]
    return data


def tree_from_json(data: dict) -> Tree:
    start, end = data["span"]
    children = tuple(tree_from_json(c) for c in data.get("children", ()))
    return Tree(int(data["node"]), int(start), int(end), children)


class VerifyError(ValueError):
    """Raised when a parse tree violates the AST rules or intervals."""


def verify_parse(tree: Tree, nodes: dict, word: str) -> None:
    """Independently check that ``tree`` is a valid parse of ``word``.

    ``nodes`` maps node ids to AST nodes.  Raises :class:`VerifyError` on
    any violation of the consumption intervals or the AST rules.
    """
    if not isinstance(tree, Tree):
        raise VerifyError("parse tree must be a Tree")
    if tree.start != 0 or tree.end != len(word):
        raise VerifyError(
            f"root span [{tree.start}, {tree.end}) does not cover the word")
    _verify(tree, nodes, word)


def _verify(t: Tree, nodes: dict, word: str) -> None:
    node = nodes.get(t.node)
    if node is None:
        raise VerifyError(f"unknown node id {t.node}")
    if not (0 <= t.start <= t.end <= len(word)):
        raise VerifyError(f"span [{t.start}, {t.end}) out of range")
    kind = node.kind
    if kind == LIT:
        if t.children:
            raise VerifyError("lit node must have no children")
        if t.end != t.start + 1:
            raise VerifyError("lit node must consume exactly one character")
        if word[t.start] != node.char:
            raise VerifyError(
                f"lit node {t.node} expects {node.char!r}, word has {word[t.start]!r}")
    elif kind == EPS:
        if t.children:
            raise VerifyError("eps node must have no children")
        if t.end != t.start:
            raise VerifyError("eps node must consume the empty interval")
    elif kind == ALT:
        if len(t.children) != 1:
            raise VerifyError("alt node must select exactly one child")
        (child,) = t.children
        allowed = (node.children[0].id, node.children[1].id)
        if child.node not in allowed:
            raise VerifyError("alt child is not one of the alternatives")
        if child.start != t.start or child.end != t.end:
            raise VerifyError("alt child must span the same interval")
        _verify(child, nodes, word)
    elif kind == CAT:
        if len(t.children) != 2:
            raise VerifyError("cat node must have exactly two children")
        left, right = t.children
        if left.node != node.children[0].id or right.node != node.children[1].id:
            raise VerifyError("cat children do not match the AST children")
        if left.start != t.start or left.end != right.start or right.end != t.end:
            raise VerifyError("cat children must consume contiguous intervals")
        _verify(left, nodes, word)
        _verify(right, nodes, word)
    elif kind == STAR:
        pos = t.start
        for child in t.children:
            if child.node != node.children[0].id:
                raise VerifyError("star repetition must parse the starred child")
            if child.start != pos:
                raise VerifyError("star repetitions must be contiguous")
            pos = child.end
            _verify(child, nodes, word)
        if pos != t.end:
            raise VerifyError("star repetitions must cover the whole interval")
    else:  # pragma: no cover - defensive
        raise VerifyError(f"unknown node kind {kind!r}")
