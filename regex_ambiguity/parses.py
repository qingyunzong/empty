"""Parse trees.

A parse tree records, for every AST node it uses, the node id and the
half-open interval [start, end) of the input word that the node consumes.
Two parses of the same word are considered different iff their trees differ
structurally (node ids, spans or children) -- never merely because the
underlying automaton took different state paths.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class Parse:
    node_id: int
    start: int
    end: int
    children: Tuple["Parse", ...] = ()


def to_json(p: Parse) -> dict:
    return {"node": p.node_id,
            "span": [p.start, p.end],
            "children": [to_json(c) for c in p.children]}


def from_json(d: dict) -> Parse:
    if not isinstance(d, dict):
        raise ValueError("parse tree must be an object")
    try:
        nid = d["node"]
        span = d["span"]
        children = d.get("children", [])
    except KeyError as exc:
        raise ValueError(f"malformed parse tree: missing {exc}") from exc
    if (not isinstance(nid, int) or isinstance(nid, bool)
            or not isinstance(span, (list, tuple)) or len(span) != 2):
        raise ValueError("malformed parse tree: bad 'node' or 'span'")
    start, end = span
    if (not isinstance(start, int) or not isinstance(end, int)
            or isinstance(start, bool) or isinstance(end, bool)):
        raise ValueError("malformed parse tree: span entries must be integers")
    if not isinstance(children, (list, tuple)):
        raise ValueError("malformed parse tree: 'children' must be a list")
    return Parse(nid, start, end, tuple(from_json(c) for c in children))
