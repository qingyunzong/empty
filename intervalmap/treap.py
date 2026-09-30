"""Persistent (path-copying) treap over canonical half-open segments.

Each node stores one segment [lo, hi) with a non-empty source multiset
(``src``: tuple of (source, count) sorted by source).  Segments are
disjoint, sorted by ``lo``, and adjacent segments never carry identical
source multisets (canonical form).  Every node caches the subtree size
and the subtree aggregate covered length, so structural rollback of the
tree also rolls back endpoint events and aggregate lengths.

Priorities are a deterministic hash of the key, so a given set of
segments always yields the same tree shape (important for persistence,
snapshots and save/restore round-trips).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Optional, Tuple

from .endpoints import cmp as epcmp, eq as epeq, seg_length


def _prio(lo) -> int:
    digest = hashlib.sha256(repr(lo).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "little")


@dataclass(frozen=True)
class Node:
    lo: Any
    hi: Any
    src: tuple
    prio: int
    left: Optional["Node"]
    right: Optional["Node"]
    size: int
    total: Any  # Fraction or math.inf


def _make(lo, hi, src, left, right) -> Node:
    size = 1 + (left.size if left else 0) + (right.size if right else 0)
    total = seg_length(lo, hi)
    if left is not None:
        total = total + left.total
    if right is not None:
        total = total + right.total
    return Node(lo, hi, src, _prio(lo), left, right, size, total)


def leaf(lo, hi, src) -> Node:
    return _make(lo, hi, src, None, None)


def inorder(root) -> list:
    out = []

    def walk(node):
        if node is None:
            return
        walk(node.left)
        out.append((node.lo, node.hi, node.src))
        walk(node.right)

    walk(root)
    return out


def max_node(root) -> Node:
    while root.right is not None:
        root = root.right
    return root


def min_node(root) -> Node:
    while root.left is not None:
        root = root.left
    return root


def split_key(root, x) -> Tuple[Optional[Node], Optional[Node]]:
    """Split into keys < x and keys >= x."""
    if root is None:
        return None, None
    if epcmp(root.lo, x) < 0:
        left, right = split_key(root.right, x)
        return _make(root.lo, root.hi, root.src, root.left, left), right
    left, right = split_key(root.left, x)
    return left, _make(root.lo, root.hi, root.src, right, root.right)


def split_at(root, x) -> Tuple[Optional[Node], Optional[Node]]:
    """Split so that the left tree covers < x and the right tree >= x.

    A segment straddling x is divided into two nodes; only the nodes on
    the search path and the straddling segment are touched.
    """
    left, right = split_key(root, x)
    if left is not None:
        m = max_node(left)
        if epcmp(m.hi, x) > 0:  # m.lo < x < m.hi
            left = delete_key(left, m.lo)
            left = insert(left, leaf(m.lo, x, m.src))
            right = insert(right, leaf(x, m.hi, m.src))
    return left, right


def insert(root, node: Node) -> Node:
    if root is None:
        return node
    if node.prio < root.prio:
        left, right = split_key(root, node.lo)
        return _make(node.lo, node.hi, node.src, left, right)
    if epcmp(node.lo, root.lo) < 0:
        return _make(root.lo, root.hi, root.src, insert(root.left, node), root.right)
    return _make(root.lo, root.hi, root.src, root.left, insert(root.right, node))


def merge_raw(left, right):
    """Treap merge; requires all keys of left < all keys of right."""
    if left is None:
        return right
    if right is None:
        return left
    if left.prio < right.prio:
        return _make(left.lo, left.hi, left.src, left.left, merge_raw(left.right, right))
    return _make(right.lo, right.hi, right.src, merge_raw(left, right.left), right.right)


def delete_key(root, lo):
    if root is None:
        return None
    c = epcmp(lo, root.lo)
    if c == 0:
        return merge_raw(root.left, root.right)
    if c < 0:
        return _make(root.lo, root.hi, root.src, delete_key(root.left, lo), root.right)
    return _make(root.lo, root.hi, root.src, root.left, delete_key(root.right, lo))


def pop_max(root) -> Tuple[Optional[Node], Node]:
    if root.right is None:
        return root.left, leaf(root.lo, root.hi, root.src)
    right, node = pop_max(root.right)
    return _make(root.lo, root.hi, root.src, root.left, right), node


def pop_min(root) -> Tuple[Optional[Node], Node]:
    if root.left is None:
        return root.right, leaf(root.lo, root.hi, root.src)
    left, node = pop_min(root.left)
    return _make(root.lo, root.hi, root.src, left, root.right), node


def concat(left, right):
    """Concatenate two trees, merging the boundary segments if adjacent
    and carrying identical source multisets."""
    if left is None:
        return right
    if right is None:
        return left
    left, lmax = pop_max(left)
    right, rmin = pop_min(right)
    if lmax.src == rmin.src and epeq(lmax.hi, rmin.lo):
        mid = leaf(lmax.lo, rmin.hi, lmax.src)
        return merge_raw(merge_raw(left, mid), right)
    return merge_raw(merge_raw(left, lmax), merge_raw(rmin, right))


def build(segments) -> Optional[Node]:
    """Build a tree from sorted, disjoint, canonical segments."""
    root = None
    for lo, hi, src in segments:
        root = insert(root, leaf(lo, hi, tuple(sorted(src.items())) if isinstance(src, dict) else tuple(src)))
    return root
