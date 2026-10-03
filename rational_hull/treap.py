"""Persistent (path-copying) treap with mergeable convex-hull summaries.

Each node stores the canonical upper and lower convex chains of its subtree
(the "mergeable balanced-tree summary").  Updates only rebuild summaries on
the search path from the root to the touched leaf -- O(depth) nodes -- and
never re-sort or rescan the whole point set.  Because nodes are immutable,
keeping an old root reference yields a free snapshot of a past version.

Priorities are derived deterministically from a SHA-256 hash of the point
key, so the tree shape (and therefore every chain summary) is reproducible
across runs and across save/load cycles, independent of insertion order.
"""

from __future__ import annotations

import hashlib

from .geometry import merge_lower, merge_upper


class UpdateCounter:
    """Instrumentation proving that updates are local, not full rebuilds."""

    __slots__ = ("nodes_visited", "chain_steps")

    def __init__(self):
        self.nodes_visited = 0
        self.chain_steps = 0


class Node:
    __slots__ = ("point", "prio", "left", "right", "count", "upper", "lower")

    def __init__(self, point, prio, left, right, count, upper, lower):
        self.point = point
        self.prio = prio
        self.left = left
        self.right = right
        self.count = count
        self.upper = upper  # canonical upper chain of the subtree (tuple)
        self.lower = lower  # canonical lower chain of the subtree (tuple)


def priority_for(point) -> int:
    """Deterministic pseudo-random priority derived from the point key."""
    digest = hashlib.sha256(
        f"{point.x}|{point.y}|{point.id}".encode("utf-8")
    ).digest()
    return int.from_bytes(digest[:8], "little")


def _count(node) -> int:
    return node.count if node is not None else 0


def _mk(point, prio, left, right, ctr) -> Node:
    """Create a node, recomputing its chain summaries from its children."""
    single = (point,)
    left_upper = left.upper if left is not None else ()
    right_upper = right.upper if right is not None else ()
    left_lower = left.lower if left is not None else ()
    right_lower = right.lower if right is not None else ()
    upper = merge_upper(merge_upper(left_upper, single, ctr), right_upper, ctr)
    lower = merge_lower(merge_lower(left_lower, single, ctr), right_lower, ctr)
    if ctr is not None:
        ctr.nodes_visited += 1
    return Node(
        point,
        prio,
        left,
        right,
        _count(left) + _count(right) + 1,
        upper,
        lower,
    )


def split(node, key, ctr):
    """Split into (nodes with key < ``key``, nodes with key >= ``key``)."""
    if node is None:
        return (None, None)
    if ctr is not None:
        ctr.nodes_visited += 1
    if node.point.key() < key:
        left, right = split(node.right, key, ctr)
        return (_mk(node.point, node.prio, node.left, left, ctr), right)
    left, right = split(node.left, key, ctr)
    return (left, _mk(node.point, node.prio, right, node.right, ctr))


def merge(a, b, ctr):
    """Merge two treaps where every key of ``a`` precedes every key of ``b``."""
    if a is None:
        return b
    if b is None:
        return a
    if ctr is not None:
        ctr.nodes_visited += 1
    if a.prio < b.prio:
        return _mk(a.point, a.prio, a.left, merge(a.right, b, ctr), ctr)
    return _mk(b.point, b.prio, merge(a, b.left, ctr), b.right, ctr)


def insert(root, point, ctr):
    """Insert ``point`` (its key must not be present); returns the new root."""
    prio = priority_for(point)
    left, right = split(root, point.key(), ctr)
    if ctr is not None:
        ctr.nodes_visited += 1
    leaf = Node(point, prio, None, None, 1, (point,), (point,))
    return merge(merge(left, leaf, ctr), right, ctr)


def delete(node, key, ctr):
    """Delete ``key`` (must be present); returns the new root."""
    if ctr is not None:
        ctr.nodes_visited += 1
    if key < node.point.key():
        return _mk(
            node.point, node.prio, delete(node.left, key, ctr), node.right, ctr
        )
    if key > node.point.key():
        return _mk(
            node.point, node.prio, node.left, delete(node.right, key, ctr), ctr
        )
    return merge(node.left, node.right, ctr)
