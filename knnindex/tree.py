"""Branch-and-bound index tree over exact rational points.

Each node maintains:
  * ``box``     -- a bounding box that always *contains* every point in the
                   subtree.  Boxes expand eagerly on insert and shrink lazily
                   (only on rebuild/split), so after deletions a box may be
                   looser than the true minimum bounding box but never smaller.
  * ``present`` / ``absent`` -- exact tag unions used for safe filter pruning.

Internal nodes are binary splits along the widest axis.  Leaves hold up to
``capacity`` entries.  Structure is immutable-on-write (copy-on-write along
the mutated path), which gives O(log n) snapshots and versioned queries.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Dict, FrozenSet, List, Optional, Tuple

from .geometry import Box, box_union, point_box

DEFAULT_LEAF_CAPACITY = 8
REBUILD_THRESHOLD = 64  # deleted entries tolerated before a leaf rebuilds


class Entry:
    __slots__ = ("point_id", "coords", "labels")

    def __init__(self, point_id: str, coords, labels: FrozenSet[str]):
        self.point_id = point_id
        self.coords = coords
        self.labels = labels

    def to_json(self):
        return {
            "id": self.point_id,
            "coords": [str(c) for c in self.coords],
            "labels": sorted(self.labels),
        }

    @staticmethod
    def from_json(data):
        return Entry(
            data["id"],
            tuple(Fraction(c) for c in data["coords"]),
            frozenset(data["labels"]),
        )


class Node:
    __slots__ = ("box", "present", "absent", "count")

    def summarize(self, entries_present, entries_absent, box, count):
        self.box = box
        self.present = entries_present
        self.absent = entries_absent
        self.count = count


class Leaf(Node):
    __slots__ = ("entries", "stale")

    def __init__(self, entries: List[Entry], stale: int = 0):
        self.entries = entries
        self.stale = stale  # deletions since last tight rebuild
        self._resummarize(tight=(stale == 0))

    def _resummarize(self, tight: bool):
        present: set = set()
        for e in self.entries:
            present |= e.labels
        # absent = union of per-point complements over the tag universe seen
        # anywhere in this leaf; tags never seen are simply "not present".
        absent: set = set()
        for e in self.entries:
            absent |= (present - e.labels)
        if tight or not hasattr(self, "box") or self.box is None:
            box = None
            for e in self.entries:
                b = point_box(e.coords)
                box = b if box is None else box_union(box, b)
            self.summarize(frozenset(present), frozenset(absent), box, len(self.entries))
        else:
            # keep the existing (possibly loose) box; summaries stay exact
            self.summarize(frozenset(present), frozenset(absent), self.box, len(self.entries))


class Internal(Node):
    __slots__ = ("left", "right")

    def __init__(self, left: Node, right: Node):
        self.left = left
        self.right = right
        box = box_union(left.box, right.box)
        self.summarize(
            left.present | right.present,
            left.absent | right.absent,
            box,
            left.count + right.count,
        )


def _split(entries: List[Entry], capacity: int) -> Tuple[List[Entry], List[Entry]]:
    """Split entries along the widest axis of their exact bounding box."""
    dims = len(entries[0].coords)
    mins = [min(e.coords[d] for e in entries) for d in range(dims)]
    maxs = [max(e.coords[d] for e in entries) for d in range(dims)]
    widths = [maxs[d] - mins[d] for d in range(dims)]
    axis = max(range(dims), key=lambda d: (widths[d], d))
    ordered = sorted(entries, key=lambda e: (e.coords[axis], e.point_id))
    mid = len(ordered) // 2
    return ordered[:mid], ordered[mid:]


def build_leaf(entries: List[Entry]) -> Leaf:
    return Leaf(list(entries), stale=0)


def insert(node: Optional[Node], entry: Entry, capacity: int) -> Node:
    if node is None:
        return Leaf([entry])
    if isinstance(node, Leaf):
        entries = node.entries + [entry]
        if len(entries) <= capacity:
            leaf = Leaf(entries, stale=node.stale)
            # expand the kept box to include the new point
            leaf.box = box_union(node.box, point_box(entry.coords))
            return leaf
        left_entries, right_entries = _split(entries, capacity)
        return Internal(build_leaf(left_entries), build_leaf(right_entries))
    # descend towards the child whose box expands less; tie -> smaller subtree
    lp = _expansion(node.left.box, entry.coords)
    rp = _expansion(node.right.box, entry.coords)
    if (lp, node.left.count) <= (rp, node.right.count):
        new_left = insert(node.left, entry, capacity)
        return Internal(new_left, node.right)
    new_right = insert(node.right, entry, capacity)
    return Internal(node.left, new_right)


def _expansion(box: Box, coords) -> Fraction:
    mins, maxs = box
    extra = Fraction(0)
    for lo, hi, x in zip(mins, maxs, coords):
        if x < lo:
            extra += (lo - x) ** 2
        elif x > hi:
            extra += (x - hi) ** 2
    return extra


def remove(node: Optional[Node], point_id: str) -> Tuple[Optional[Node], Optional[Entry]]:
    """Remove ``point_id``; returns (new_node, removed_entry_or_None).

    Boxes are deliberately *not* shrunk here (lazy shrink); tag summaries are
    recomputed exactly.  Leaves that accumulate too many deletions are rebuilt
    with a tight box so bounds cannot stay loose forever.
    """
    if node is None:
        return None, None
    if isinstance(node, Leaf):
        for i, e in enumerate(node.entries):
            if e.point_id == point_id:
                entries = node.entries[:i] + node.entries[i + 1 :]
                if not entries:
                    return None, e
                stale = node.stale + 1
                if stale >= REBUILD_THRESHOLD:
                    return Leaf(entries, stale=0), e
                leaf = Leaf(entries, stale=stale)
                leaf.box = node.box  # keep old box: safe (superset), lazy shrink
                return leaf, e
        return node, None
    left, removed = remove(node.left, point_id)
    if removed is not None:
        if left is None:
            return node.right, removed
        return Internal(left, node.right), removed
    right, removed = remove(node.right, point_id)
    if removed is not None:
        if right is None:
            return node.left, removed
        return Internal(node.left, right), removed
    return node, None


def find_entry(node: Optional[Node], point_id: str) -> Optional[Entry]:
    if node is None:
        return None
    if isinstance(node, Leaf):
        for e in node.entries:
            if e.point_id == point_id:
                return e
        return None
    return find_entry(node.left, point_id) or find_entry(node.right, point_id)


def iter_entries(node: Optional[Node]):
    if node is None:
        return
    if isinstance(node, Leaf):
        yield from node.entries
        return
    yield from iter_entries(node.left)
    yield from iter_entries(node.right)


def node_to_json(node: Optional[Node]):
    if node is None:
        return None
    if isinstance(node, Leaf):
        return {
            "type": "leaf",
            "stale": node.stale,
            "box": _box_json(node.box),
            "entries": [e.to_json() for e in node.entries],
        }
    return {
        "type": "internal",
        "box": _box_json(node.box),
        "left": node_to_json(node.left),
        "right": node_to_json(node.right),
    }


def node_from_json(data) -> Optional[Node]:
    if data is None:
        return None
    if data["type"] == "leaf":
        leaf = Leaf([Entry.from_json(e) for e in data["entries"]], stale=data["stale"])
        leaf.box = _box_parse(data["box"])
        leaf._resummarize(tight=False)
        return leaf
    left = node_from_json(data["left"])
    right = node_from_json(data["right"])
    node = Internal(left, right)
    node.box = _box_parse(data["box"])  # preserved lazily-shrunk box
    return node


def _box_json(box: Box):
    return [[str(c) for c in box[0]], [str(c) for c in box[1]]]


def _box_parse(data) -> Box:
    return (
        tuple(Fraction(c) for c in data[0]),
        tuple(Fraction(c) for c in data[1]),
    )
