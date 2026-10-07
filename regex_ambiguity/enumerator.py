"""Independent bounded parse-tree enumeration.

A separate, straightforward implementation used to cross-check the analyser
on small inputs: it enumerates parse trees of a word directly from the AST
rules.  A star may take at most `zero_iter_cap` zero-width iterations, which
keeps enumeration finite while still exposing pumpable epsilon loops (any
parse containing a star with a nullable body shows up).
"""
from __future__ import annotations

from typing import Dict, Set, Tuple

from .astnodes import Node, Lit, Eps, Union, Cat, Star, iter_nodes
from .parses import Parse


def _nullable_map(root: Node) -> Dict[int, bool]:
    memo: Dict[int, bool] = {}

    def go(node: Node) -> bool:
        if node.id in memo:
            return memo[node.id]
        if isinstance(node, Lit):
            res = False
        elif isinstance(node, Eps):
            res = True
        elif isinstance(node, Union):
            res = any(go(c) for c in node.children)
        elif isinstance(node, Cat):
            res = all(go(c) for c in node.children)
        elif isinstance(node, Star):
            res = True
        else:
            raise TypeError(node)
        memo[node.id] = res
        return res

    for n in iter_nodes(root):
        go(n)
    return memo


def enumerate_parses(root: Node, word: str, zero_iter_cap: int = 3) -> Set[Parse]:
    """All parse trees of `word` under the bounded zero-width-iteration cap."""
    memo: Dict[Tuple[int, int, int], Set[Tuple[int, Parse]]] = {}

    def enum(node: Node, pos: int, zcap: int) -> Set[Tuple[int, Parse]]:
        key = (node.id, pos, zcap)
        if key in memo:
            return memo[key]
        res: Set[Tuple[int, Parse]] = set()
        if isinstance(node, Lit):
            if pos < len(word) and word[pos] == node.char:
                res.add((pos + 1, Parse(node.id, pos, pos + 1, ())))
        elif isinstance(node, Eps):
            res.add((pos, Parse(node.id, pos, pos, ())))
        elif isinstance(node, Union):
            for c in node.children:
                res |= enum(c, pos, zcap)
        elif isinstance(node, Cat):
            acc: Set[Tuple[int, Tuple[Parse, ...]]] = {(pos, ())}
            for c in node.children:
                nxt: Set[Tuple[int, Tuple[Parse, ...]]] = set()
                for p0, trees in acc:
                    for e, t in enum(c, p0, zcap):
                        nxt.add((e, trees + (t,)))
                acc = nxt
            for e, trees in acc:
                res.add((e, Parse(node.id, pos, e, trees)))
        elif isinstance(node, Star):
            res.add((pos, Parse(node.id, pos, pos, ())))
            for e, t in enum(node.child, pos, zcap):
                if e == pos:
                    if zcap <= 0:
                        continue
                    tails = enum(node, pos, zcap - 1)
                else:
                    tails = enum(node, e, zcap)
                for e2, t2 in tails:
                    res.add((e2, Parse(node.id, pos, e2, (t,) + t2.children)))
        else:
            raise TypeError(node)
        memo[key] = res
        return res

    return {t for e, t in enum(root, 0, zero_iter_cap) if e == len(word)}


def nullable_star_ids(root: Node) -> Set[int]:
    nullable = _nullable_map(root)
    return {n.id for n in iter_nodes(root)
            if isinstance(n, Star) and nullable[n.child.id]}


def tree_contains_any(tree: Parse, ids: Set[int]) -> bool:
    if tree.node_id in ids:
        return True
    return any(tree_contains_any(c, ids) for c in tree.children)
