"""Dynamic branch-and-bound index over rational vectors.

The index is an R-tree-like balanced hierarchy.  Every node maintains:

* ``bbox``      -- an axis-aligned bounding box that is always a *superset*
                   of the points in the subtree (safe for distance pruning);
* ``tags_any``  -- a superset of the union of subtree tags;
* ``tags_all``  -- a subset of the intersection of subtree tags.

Safety invariant: bounds and summaries may be *stale* (too large / too
small respectively) after deletions, but they never over-shrink.  Leaf
bounds are recomputed exactly on delete; internal bounds shrink lazily,
only when a structural change (split) recomputes them from children.
"""

from __future__ import annotations

import json

from .errors import DimensionError, DuplicateIdError, StaleVersionError
from .exact import (
    bbox_center,
    bbox_enlargement,
    bbox_from_points,
    bbox_union,
    bbox_union_point,
    bbox_volume,
    bbox_widest_dim,
    frac_str,
    idkey,
    parse_vector,
)

FORMAT = "rknni/1"


class Point:
    __slots__ = ("id", "vector", "tags", "version")

    def __init__(self, pid, vector, tags, version):
        self.id = pid
        self.vector = vector
        self.tags = frozenset(tags)
        self.version = version

    def to_dict(self):
        return {
            "id": self.id,
            "vector": [frac_str(x) for x in self.vector],
            "tags": sorted(self.tags),
            "version": self.version,
        }


class Node:
    __slots__ = (
        "node_id", "leaf", "bbox", "tags_any", "tags_all",
        "children", "entries", "parent",
    )

    def __init__(self, node_id, leaf):
        self.node_id = node_id
        self.leaf = leaf
        self.bbox = None
        self.tags_any = set()
        self.tags_all = set()
        self.children = []
        self.entries = []
        self.parent = None


class Index:
    """Exact-KNN branch-and-bound index.

    ``capacity`` is the maximum number of points per leaf, ``fanout`` the
    maximum number of children per internal node.
    """

    def __init__(self, dim, capacity=8, fanout=8):
        if not isinstance(dim, int) or isinstance(dim, bool) or dim < 1:
            raise ValueError("dim must be a positive integer")
        if capacity < 2 or fanout < 2:
            raise ValueError("capacity and fanout must be >= 2")
        self.dim = dim
        self.capacity = capacity
        self.fanout = fanout
        self._points = {}
        self._leaf_of = {}
        self._next_nid = 1
        self.root = self._new_node(leaf=True)
        self.data_version = 0

    # ------------------------------------------------------------------
    # introspection
    # ------------------------------------------------------------------
    def __len__(self):
        return len(self._points)

    def __contains__(self, pid):
        return pid in self._points

    def get(self, pid):
        return self._points[pid]

    def points(self):
        return [self._points[k] for k in sorted(self._points, key=idkey)]

    def total_nodes(self):
        count = 0
        stack = [self.root]
        while stack:
            node = stack.pop()
            count += 1
            stack.extend(node.children)
        return count

    # ------------------------------------------------------------------
    # mutation (public API bumps the data version exactly once)
    # ------------------------------------------------------------------
    def insert(self, pid, vector, tags=(), version=1):
        """Insert a new point.  Raises DuplicateIdError if id exists."""
        if pid in self._points:
            raise DuplicateIdError(f"duplicate point id: {pid!r}")
        self._insert_point(self._make_point(pid, vector, tags, version))
        self.data_version += 1

    def upsert(self, pid, vector, tags=(), version=None):
        """Insert or replace; ``version`` must be newer than the stored one."""
        if version is None:
            raise ValueError("upsert requires an explicit version")
        old = self._points.get(pid)
        if old is not None:
            if version <= old.version:
                raise StaleVersionError(
                    f"version {version} is not newer than stored {old.version}"
                )
            self._delete_point(pid)
        self._insert_point(self._make_point(pid, vector, tags, version))
        self.data_version += 1

    def delete(self, pid):
        """Remove a point.  Raises KeyError if the id is unknown."""
        self._delete_point(pid)
        self.data_version += 1

    # ------------------------------------------------------------------
    # snapshots and persistence
    # ------------------------------------------------------------------
    def snapshot(self):
        """Return an independent deep copy frozen at the current version."""
        return self.from_dict(self.to_dict())

    def to_dict(self):
        return {
            "format": FORMAT,
            "dim": self.dim,
            "capacity": self.capacity,
            "fanout": self.fanout,
            "data_version": self.data_version,
            "points": [p.to_dict() for p in self.points()],
        }

    @classmethod
    def from_dict(cls, data):
        if data.get("format") != FORMAT:
            raise ValueError(f"unsupported format: {data.get('format')!r}")
        idx = cls(data["dim"], data["capacity"], data["fanout"])
        for pd in data["points"]:
            idx._insert_point(
                idx._make_point(pd["id"], pd["vector"], pd["tags"], pd["version"])
            )
        idx.data_version = data["data_version"]
        return idx

    def save(self, path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, indent=2, sort_keys=True)

    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))

    # ------------------------------------------------------------------
    # querying
    # ------------------------------------------------------------------
    def query(self, vector, k, filter=None, budget=None):
        from .query import run_query

        return run_query(self, vector, k, filter, budget)

    def cursor(self, vector, k, filter=None, budget=None):
        from .query import Cursor

        return Cursor(self, vector, k, filter, budget)

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _new_node(self, leaf):
        node = Node(self._next_nid, leaf)
        self._next_nid += 1
        return node

    def _make_point(self, pid, vector, tags, version):
        if isinstance(pid, bool) or not isinstance(pid, (int, str)):
            raise TypeError("point id must be an int or a str")
        vec = parse_vector(vector)
        if len(vec) != self.dim:
            raise DimensionError(
                f"expected dimension {self.dim}, got {len(vec)}"
            )
        tags = tuple(tags)
        for tag in tags:
            if not isinstance(tag, str):
                raise TypeError("tags must be strings")
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ValueError("version must be a positive integer")
        return Point(pid, vec, tags, version)

    def _insert_point(self, point):
        self._points[point.id] = point
        node = self.root
        while not node.leaf:
            self._expand_node(node, point)
            node = self._choose_child(node, point)
        node.entries.append(point)
        self._leaf_of[point.id] = node
        self._recompute_leaf(node)
        if len(node.entries) > self.capacity:
            self._split_and_propagate(node)

    def _delete_point(self, pid):
        point = self._points.pop(pid)  # KeyError if missing
        leaf = self._leaf_of.pop(pid)
        leaf.entries.remove(point)
        # Exact shrink of the leaf; internal ancestors keep their stale
        # (superset) bounds and summaries -- lazy, never over-shrunk.
        self._recompute_leaf(leaf)
        node = leaf
        while node is not self.root and self._node_empty(node):
            parent = node.parent
            parent.children.remove(node)
            node = parent
        root = self.root
        if not root.leaf:
            while not root.leaf and len(root.children) == 1:
                root = root.children[0]
                root.parent = None
                self.root = root
            if not root.leaf and not root.children:
                self.root = self._new_node(leaf=True)

    @staticmethod
    def _node_empty(node):
        return not (node.entries if node.leaf else node.children)

    def _expand_node(self, node, point):
        node.bbox = bbox_union_point(node.bbox, point.vector)
        node.tags_any |= point.tags
        node.tags_all &= point.tags

    def _choose_child(self, node, point):
        best = None
        best_key = None
        for child in node.children:
            if child.bbox is None:
                continue
            key = (
                bbox_enlargement(child.bbox, point.vector),
                bbox_volume(child.bbox),
                child.node_id,
            )
            if best_key is None or key < best_key:
                best_key = key
                best = child
        if best is None:
            raise RuntimeError("internal node has no usable child")
        return best

    def _recompute_leaf(self, node):
        if not node.entries:
            node.bbox = None
            node.tags_any = set()
            node.tags_all = set()
            return
        node.bbox = bbox_from_points([p.vector for p in node.entries])
        node.tags_any = set().union(*(p.tags for p in node.entries))
        node.tags_all = set(node.entries[0].tags)
        for p in node.entries[1:]:
            node.tags_all &= p.tags

    def _recompute_internal(self, node):
        boxes = [c.bbox for c in node.children if c.bbox is not None]
        bbox = boxes[0] if boxes else None
        for other in boxes[1:]:
            bbox = bbox_union(bbox, other)
        node.bbox = bbox
        if node.children:
            node.tags_any = set().union(*(c.tags_any for c in node.children))
            node.tags_all = set(node.children[0].tags_all)
            for c in node.children[1:]:
                node.tags_all &= c.tags_all
        else:
            node.tags_any = set()
            node.tags_all = set()

    def _split_node(self, node):
        dim = bbox_widest_dim(node.bbox)
        if node.leaf:
            items = sorted(
                node.entries, key=lambda p: (p.vector[dim], idkey(p.id))
            )
        else:
            items = sorted(
                node.children,
                key=lambda c: (bbox_center(c.bbox)[dim], c.node_id),
            )
        mid = len(items) // 2
        right = self._new_node(leaf=node.leaf)
        right.parent = node.parent
        if node.leaf:
            node.entries = items[:mid]
            right.entries = items[mid:]
            self._recompute_leaf(node)
            self._recompute_leaf(right)
            for p in right.entries:
                self._leaf_of[p.id] = right
        else:
            node.children = items[:mid]
            right.children = items[mid:]
            for child in node.children:
                child.parent = node
            for child in right.children:
                child.parent = right
            self._recompute_internal(node)
            self._recompute_internal(right)
        return node, right

    def _split_and_propagate(self, node):
        while True:
            left, right = self._split_node(node)
            parent = left.parent
            if parent is None:
                root = self._new_node(leaf=False)
                root.children = [left, right]
                left.parent = right.parent = root
                self._recompute_internal(root)
                self.root = root
                return
            pos = parent.children.index(left)
            parent.children[pos:pos + 1] = [left, right]
            right.parent = parent
            # Recomputed from children: a superset of all subtree points,
            # and still contained in the (already expanded) ancestors.
            self._recompute_internal(parent)
            if len(parent.children) <= self.fanout:
                return
            node = parent
