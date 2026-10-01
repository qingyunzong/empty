"""Persistent treap whose nodes carry mergeable convex-hull summaries.

Each node caches the upper/lower hull chains of its subtree, merged from
its children in O(k log k) where k is the combined child chain length --
never by rescanning the whole subtree.  Updates are path-copying, so old
roots stay valid: a snapshot is just a root reference.

``stats`` is a dict with counters ``visited`` (nodes examined on the
search path) and ``created`` (fresh nodes allocated, i.e. the real work
done by an update).  A full rebuild would create Theta(n) nodes per
update; local maintenance creates Theta(log n).
"""
import hashlib

from .geometry import lower_chain, upper_chain


def priority_for(key):
    """Deterministic pseudo-random treap priority (stable across runs)."""
    digest = hashlib.sha256(repr(key).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


class Node:
    __slots__ = ("key", "prio", "left", "right", "upper", "lower", "size")

    def __init__(self, key, prio, left, right):
        self.key = key
        self.prio = prio
        self.left = left
        self.right = right
        candidates = [key]
        if left is not None:
            candidates.extend(left.upper)
            candidates.extend(left.lower)
        if right is not None:
            candidates.extend(right.upper)
            candidates.extend(right.lower)
        ordered = sorted(set(candidates))
        # Mergeable summary: hull of the union of the children's hulls.
        self.upper = upper_chain(ordered)
        self.lower = lower_chain(ordered)
        self.size = 1
        if left is not None:
            self.size += left.size
        if right is not None:
            self.size += right.size


def _make(key, prio, left, right, stats):
    stats["created"] += 1
    return Node(key, prio, left, right)


def _rotate_right(node, stats):
    child = node.left
    lowered = _make(node.key, node.prio, child.right, node.right, stats)
    return _make(child.key, child.prio, child.left, lowered, stats)


def _rotate_left(node, stats):
    child = node.right
    lowered = _make(node.key, node.prio, node.left, child.left, stats)
    return _make(child.key, child.prio, lowered, child.right, stats)


def insert(root, key, stats):
    """Persistent insert; returns the new root.  Raises on duplicate key."""
    return _insert(root, key, priority_for(key), stats)


def _insert(node, key, prio, stats):
    stats["visited"] += 1
    if node is None:
        return _make(key, prio, None, None, stats)
    if key < node.key:
        left = _insert(node.left, key, prio, stats)
        node = _make(node.key, node.prio, left, node.right, stats)
        if left.prio < node.prio:
            node = _rotate_right(node, stats)
    elif key > node.key:
        right = _insert(node.right, key, prio, stats)
        node = _make(node.key, node.prio, node.left, right, stats)
        if right.prio < node.prio:
            node = _rotate_left(node, stats)
    else:
        raise ValueError("duplicate key")
    return node


def delete(root, key, stats):
    """Persistent delete; returns the new root.  Raises if key missing."""
    return _delete(root, key, stats)


def _delete(node, key, stats):
    stats["visited"] += 1
    if node is None:
        raise KeyError(key)
    if key < node.key:
        return _make(node.key, node.prio, _delete(node.left, key, stats), node.right, stats)
    if key > node.key:
        return _make(node.key, node.prio, node.left, _delete(node.right, key, stats), stats)
    if node.left is None:
        return node.right
    if node.right is None:
        return node.left
    if node.left.prio < node.right.prio:
        promoted = _rotate_right(node, stats)
        return _make(promoted.key, promoted.prio, promoted.left,
                     _delete(promoted.right, key, stats), stats)
    promoted = _rotate_left(node, stats)
    return _make(promoted.key, promoted.prio, _delete(promoted.left, key, stats),
                 promoted.right, stats)
