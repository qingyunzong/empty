"""Pumpable epsilon-cycle evidence for a concrete witness word.

If a word has a parse tree containing a star whose child is nullable,
one more empty repetition of that child can always be inserted, so the
word has infinitely many parses.  This module decides, for a given word,
whether such a parse exists and constructs a concrete base parse plus
its one-step pumped variant as verifiable evidence.
"""
from __future__ import annotations

from functools import lru_cache

from .syntax import LIT, EPS, ALT, CAT, STAR
from .parsetree import Tree, shift, tree_to_json
from .properties import nullable


def epsilon_witness(node) -> Tree:
    """A parse tree of the empty word for a nullable node."""
    kind = node.kind
    if kind == EPS:
        return Tree(node.id, 0, 0)
    if kind == ALT:
        left, right = node.children
        child = left if nullable(left) else right
        return Tree(node.id, 0, 0, (epsilon_witness(child),))
    if kind == CAT:
        return Tree(node.id, 0, 0,
                    (epsilon_witness(node.children[0]),
                     epsilon_witness(node.children[1])))
    if kind == STAR:
        return Tree(node.id, 0, 0, ())
    raise ValueError("node is not nullable")


def epsilon_loop_evidence(root, nodes: dict, word: str) -> dict | None:
    """Return pumpable epsilon-cycle evidence for ``word``, or None."""

    @lru_cache(maxsize=None)
    def has_parse(node, i, j):
        kind = node.kind
        if kind == LIT:
            return j == i + 1 and word[i] == node.char
        if kind == EPS:
            return i == j
        if kind == ALT:
            return has_parse(node.children[0], i, j) or has_parse(node.children[1], i, j)
        if kind == CAT:
            left, right = node.children
            return any(has_parse(left, i, m) and has_parse(right, m, j)
                       for m in range(i, j + 1))
        # STAR: empty repetitions are never needed for mere existence.
        if i == j:
            return True
        child = node.children[0]
        return any(has_parse(child, i, m) and has_parse(node, m, j)
                   for m in range(i + 1, j + 1))

    @lru_cache(maxsize=None)
    def has_loop_parse(node, i, j):
        """True if some parse of word[i:j] contains a nullable-child star."""
        kind = node.kind
        if kind in (LIT, EPS):
            return False
        if kind == ALT:
            return (has_loop_parse(node.children[0], i, j)
                    or has_loop_parse(node.children[1], i, j))
        if kind == CAT:
            left, right = node.children
            return any((has_parse(left, i, m) and has_loop_parse(right, m, j))
                       or (has_loop_parse(left, i, m) and has_parse(right, m, j))
                       for m in range(i, j + 1))
        child = node.children[0]
        if nullable(child) and has_parse(node, i, j):
            return True
        return any((has_loop_parse(child, i, m) and has_parse(node, m, j))
                   or (has_parse(child, i, m) and has_loop_parse(node, m, j))
                   for m in range(i + 1, j + 1))

    def witness(node, i, j) -> Tree:
        kind = node.kind
        if kind == LIT:
            return Tree(node.id, i, j)
        if kind == EPS:
            return Tree(node.id, i, i)
        if kind == ALT:
            left, right = node.children
            child = left if has_parse(left, i, j) else right
            return Tree(node.id, i, j, (witness(child, i, j),))
        if kind == CAT:
            left, right = node.children
            for m in range(i, j + 1):
                if has_parse(left, i, m) and has_parse(right, m, j):
                    return Tree(node.id, i, j,
                                (witness(left, i, m), witness(right, m, j)))
        # STAR
        if i == j:
            return Tree(node.id, i, i, ())
        child = node.children[0]
        for m in range(i + 1, j + 1):
            if has_parse(child, i, m) and has_parse(node, m, j):
                rest = witness(node, m, j)
                return Tree(node.id, i, j, (witness(child, i, m),) + rest.children)
        raise AssertionError("no parse exists")

    def loop_witness(node, i, j) -> Tree:
        kind = node.kind
        if kind == ALT:
            left, right = node.children
            child = left if has_loop_parse(left, i, j) else right
            return Tree(node.id, i, j, (loop_witness(child, i, j),))
        if kind == CAT:
            left, right = node.children
            for m in range(i, j + 1):
                if has_parse(left, i, m) and has_loop_parse(right, m, j):
                    return Tree(node.id, i, j,
                                (witness(left, i, m), loop_witness(right, m, j)))
                if has_loop_parse(left, i, m) and has_parse(right, m, j):
                    return Tree(node.id, i, j,
                                (loop_witness(left, i, m), witness(right, m, j)))
        if kind == STAR:
            child = node.children[0]
            if nullable(child) and has_parse(node, i, j):
                return witness(node, i, j)
            for m in range(i + 1, j + 1):
                if has_loop_parse(child, i, m) and has_parse(node, m, j):
                    rest = witness(node, m, j)
                    return Tree(node.id, i, j,
                                (loop_witness(child, i, m),) + rest.children)
                if has_parse(child, i, m) and has_loop_parse(node, m, j):
                    rest = loop_witness(node, m, j)
                    return Tree(node.id, i, j,
                                (witness(child, i, m),) + rest.children)
        raise AssertionError("no loop parse exists")

    def pump(tree):
        """Insert one extra empty repetition into the first pumpable star."""
        node = nodes[tree.node]
        if node.kind == STAR and nullable(node.children[0]):
            unit = shift(epsilon_witness(node.children[0]), tree.end)
            return Tree(tree.node, tree.start, tree.end, tree.children + (unit,)), tree
        for idx, child in enumerate(tree.children):
            res = pump(child)
            if res is not None:
                new_child, star_sub = res
                children = list(tree.children)
                children[idx] = new_child
                return Tree(tree.node, tree.start, tree.end, tuple(children)), star_sub
        return None

    if not has_loop_parse(root, 0, len(word)):
        return None
    base = loop_witness(root, 0, len(word))
    pumped, star_sub = pump(base)
    star_node = nodes[star_sub.node]
    unit = shift(epsilon_witness(star_node.children[0]), star_sub.end)
    return {
        "star_node": star_sub.node,
        "span": [star_sub.start, star_sub.end],
        "unit_epsilon_parse": tree_to_json(unit),
        "base_parse": tree_to_json(base),
        "pumped_parse": tree_to_json(pumped),
        "explanation": (
            f"star node {star_sub.node} has a nullable child, so its "
            f"empty-word repetition at span [{star_sub.start}, "
            f"{star_sub.end}) can be pumped arbitrarily often, giving "
            f"infinitely many parse trees for {word!r}"
        ),
    }
