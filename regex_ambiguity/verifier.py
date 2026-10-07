"""Independent parse-tree verifier.

Given an AST, a word and a candidate parse tree, checks that every node's
consumed interval is consistent with the AST rules.  This module shares no
logic with the analyser's parse reconstruction, so analyser evidence can be
audited independently (and tampered evidence is rejected).
"""
from __future__ import annotations

from typing import Optional, Tuple

from .astnodes import Node, Lit, Eps, Union, Cat, Star, validate
from .parses import Parse

_MAX_DEPTH = 100000


def verify_parse(root: Node, word: str, parse: Parse) -> Tuple[bool, str]:
    """Returns (ok, error).  ok is True iff `parse` is a valid parse of the
    whole of `word` according to `root`."""
    try:
        validate(root)
    except Exception as exc:
        return False, f"invalid AST: {exc}"
    if not isinstance(parse, Parse):
        return False, "parse must be a Parse instance"
    err = _check(root, word, parse, 0, len(word), 0)
    if err is not None:
        return False, err
    return True, ""


def _check(node: Node, word: str, p: Parse, lo: int, hi: int, depth: int) -> Optional[str]:
    if depth > _MAX_DEPTH:
        return "parse tree too deep"
    if not isinstance(p, Parse):
        return f"node {node.id}: child is not a parse tree"
    if p.node_id != node.id:
        return f"expected parse of node {node.id}, found node {p.node_id}"
    if p.start != lo or p.end != hi:
        return (f"node {node.id}: span [{p.start},{p.end}) does not match "
                f"expected [{lo},{hi})")
    if not (0 <= p.start <= p.end <= len(word)):
        return f"node {node.id}: span [{p.start},{p.end}) out of bounds"
    if isinstance(node, Lit):
        if p.children:
            return f"literal node {node.id} must have no children"
        if p.end != p.start + 1:
            return f"literal node {node.id} must consume exactly one character"
        if word[p.start] != node.char:
            return (f"literal node {node.id}: expected {node.char!r}, "
                    f"found {word[p.start]!r}")
        return None
    if isinstance(node, Eps):
        if p.children:
            return f"epsilon node {node.id} must have no children"
        if p.start != p.end:
            return f"epsilon node {node.id} must consume nothing"
        return None
    if isinstance(node, Union):
        if len(p.children) != 1:
            return f"union node {node.id} must have exactly one child"
        child_parse = p.children[0]
        for c in node.children:
            if c.id == child_parse.node_id:
                return _check(c, word, child_parse, lo, hi, depth + 1)
        return (f"union node {node.id}: child parse of node "
                f"{child_parse.node_id} is not one of its branches")
    if isinstance(node, Cat):
        if len(p.children) != len(node.children):
            return (f"cat node {node.id}: expected {len(node.children)} children, "
                    f"found {len(p.children)}")
        pos = lo
        for c, cp in zip(node.children, p.children):
            if cp.start != pos:
                return (f"cat node {node.id}: child spans are not contiguous "
                        f"at position {pos}")
            err = _check(c, word, cp, pos, cp.end, depth + 1)
            if err:
                return err
            pos = cp.end
        if pos != hi:
            return f"cat node {node.id}: children do not cover the whole span"
        return None
    if isinstance(node, Star):
        pos = lo
        for cp in p.children:
            if cp.node_id != node.child.id:
                return (f"star node {node.id}: iteration must parse body node "
                        f"{node.child.id}, found {cp.node_id}")
            if cp.start != pos:
                return (f"star node {node.id}: iteration spans are not "
                        f"contiguous at position {pos}")
            err = _check(node.child, word, cp, pos, cp.end, depth + 1)
            if err:
                return err
            pos = cp.end
        if pos != hi:
            return f"star node {node.id}: iterations do not cover the whole span"
        return None
    return f"unknown AST node type for id {node.id}"
