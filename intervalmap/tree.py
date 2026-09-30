"""Persistent (copy-on-write) balanced interval tree.

A treap whose nodes are maximal half-open segments [start, end) sharing the
same source multiset.  Keys are segment starts (segments are disjoint and
sorted).  All update operations are path-copying: old roots stay valid, which
is what makes snapshots and nested-transaction rollback cheap.

Only nodes intersecting a modified range are touched: ``split_at`` isolates
the range in O(log n) path copies and the middle is rebuilt from exactly the
intersecting segments.
"""

from __future__ import annotations

import hashlib
from fractions import Fraction

from .endpoints import NEG_INF, POS_INF  # noqa: F401  (re-exported)

EMPTY_SOURCES: tuple = ()


def _priority(start) -> int:
    digest = hashlib.sha256(repr(start).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


def norm_sources(sources) -> tuple:
    """Normalize a mapping/tuple into a sorted tuple of (source, count)."""
    if isinstance(sources, tuple):
        items = sources
    else:
        items = tuple(sources.items())
    items = tuple((s, c) for s, c in items if c > 0)
    return tuple(sorted(items, key=lambda kv: kv[0]))


def sources_to_dict(sources: tuple) -> dict:
    return dict(sources)


def source_total(sources: tuple) -> int:
    return sum(c for _, c in sources)


class Node:
    __slots__ = ("start", "end", "sources", "prio", "left", "right", "total")

    def __init__(self, start, end, sources, left=None, right=None):
        self.start = start
        self.end = end
        self.sources = sources
        self.prio = _priority(start)
        self.left = left
        self.right = right
        self.total = (end - start) + _total(left) + _total(right)

    def __repr__(self):
        return f"Node({self.start!r}, {self.end!r}, {self.sources!r})"


def _total(node):
    return node.total if node is not None else Fraction(0)


def total_length(root):
    return _total(root)


def inorder(root, out=None):
    if out is None:
        out = []
    if root is not None:
        inorder(root.left, out)
        out.append(root)
        inorder(root.right, out)
    return out


def split(root, key):
    """Split by start key: left starts < key <= right starts."""
    if root is None:
        return None, None
    if key <= root.start:
        left, mid = split(root.left, key)
        return left, Node(root.start, root.end, root.sources, mid, root.right)
    mid, right = split(root.right, key)
    return Node(root.start, root.end, root.sources, root.left, mid), right


def merge(left, right):
    """Merge two treaps where every key in left < every key in right."""
    if left is None:
        return right
    if right is None:
        return left
    if left.prio > right.prio:
        return Node(left.start, left.end, left.sources, left.left, merge(left.right, right))
    return Node(right.start, right.end, right.sources, merge(left, right.left), right.right)


def find_containing(root, x):
    """Node with start <= x < end, or None (x may be -inf)."""
    while root is not None:
        if x < root.start:
            root = root.left
        elif x < root.end:
            return root
        else:
            root = root.right
    return None


def min_node(root):
    while root is not None and root.left is not None:
        root = root.left
    return root


def max_node(root):
    while root is not None and root.right is not None:
        root = root.right
    return root


def split_at(root, x):
    """Split so that left ends <= x and right starts >= x.

    A segment straddling x is divided into two nodes with identical sources.
    """
    left, right = split(root, x)
    if left is None:
        return None, right
    last = max_node(left)
    if last is not None and last.end > x:
        # `last` straddles x: detach it and emit two halves.
        left, _ = split(left, last.start)
        left = merge(left, Node(last.start, x, last.sources))
        right = merge(Node(x, last.end, last.sources), right)
    return left, right


def split_first(root):
    """Split off the minimum node: returns (node, rest)."""
    if root.left is None:
        return Node(root.start, root.end, root.sources), root.right
    node, new_left = split_first(root.left)
    return node, Node(root.start, root.end, root.sources, new_left, root.right)


def build_from_sorted(pieces):
    """Build a treap from sorted (start, end, sources) triples."""
    root = None
    for start, end, sources in pieces:
        root = merge(root, Node(start, end, sources))
    return root


def merge_canonical(left, right):
    """Merge two treaps, fusing the boundary segments if sources match."""
    if left is None:
        return right
    if right is None:
        return left
    last = max_node(left)
    first = min_node(right)
    if last is not None and first is not None and last.end == first.start \
            and last.sources == first.sources:
        left, _ = split(left, last.start)
        _, right = split_first(right)
        fused = Node(last.start, first.end, last.sources)
        return merge(merge(left, fused), right)
    return merge(left, right)
