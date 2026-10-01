"""Versioned exact-KNN index over rational vectors.

Mutations (insert / delete / replace) are copy-on-write: every mutation bumps
``version`` and produces a new root, while older roots stay reachable through
snapshots.  Query cursors are bound to the data version that created them;
resuming against any other version raises :class:`StaleCursorError`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from fractions import Fraction
from typing import Dict, List, Optional, Tuple

from .geometry import to_point
from .query import QueryResult, StaleCursorError, search
from .tree import (
    DEFAULT_LEAF_CAPACITY,
    Entry,
    Node,
    find_entry,
    insert,
    iter_entries,
    node_from_json,
    node_to_json,
    remove,
)

FORMAT_VERSION = 1


@dataclass(frozen=True)
class Cursor:
    """Opaque resumption token for an interrupted (budget-exhausted) query."""

    version: int
    k: int
    query: tuple
    filter_expr: Optional[dict]
    frontier: Tuple[Tuple[Fraction, Tuple[int, ...]], ...]
    hits: Tuple[Tuple[Fraction, str], ...]

    def to_json(self):
        return {
            "version": self.version,
            "k": self.k,
            "query": [str(c) for c in self.query],
            "filter": self.filter_expr,
            "frontier": [
                {"bound": str(b), "path": list(p)} for b, p in self.frontier
            ],
            "hits": [{"id": pid, "dist2": str(d)} for d, pid in self.hits],
        }

    @staticmethod
    def from_json(data) -> "Cursor":
        return Cursor(
            version=data["version"],
            k=data["k"],
            query=tuple(Fraction(c) for c in data["query"]),
            filter_expr=data["filter"],
            frontier=tuple(
                (Fraction(item["bound"]), tuple(item["path"]))
                for item in data["frontier"]
            ),
            hits=tuple((Fraction(h["dist2"]), h["id"]) for h in data["hits"]),
        )


class KNNIndex:
    def __init__(self, dims: int, leaf_capacity: int = DEFAULT_LEAF_CAPACITY):
        if dims <= 0:
            raise ValueError("dims must be positive")
        self.dims = dims
        self.leaf_capacity = leaf_capacity
        self.version = 0
        self._root: Optional[Node] = None
        self._live: Dict[str, None] = {}  # id set for O(1) existence checks
        self._snapshots: Dict[int, Node] = {}

    # ------------------------------------------------------------------ util

    def _check_coords(self, coords) -> tuple:
        point = to_point(coords)
        if len(point) != self.dims:
            raise ValueError(f"expected {self.dims} dims, got {len(point)}")
        return point

    def _root_at(self, version: Optional[int]) -> Optional[Node]:
        if version is None or version == self.version:
            return self._root
        if version not in self._snapshots:
            raise KeyError(f"unknown snapshot version: {version}")
        return self._snapshots[version]

    # -------------------------------------------------------------- mutation

    def insert(self, point_id: str, coords, labels=()) -> int:
        if point_id in self._live:
            raise KeyError(f"duplicate id: {point_id!r}")
        point = self._check_coords(coords)
        entry = Entry(point_id, point, frozenset(labels))
        self._root = insert(self._root, entry, self.leaf_capacity)
        self._live[point_id] = None
        self.version += 1
        return self.version

    def delete(self, point_id: str) -> bool:
        if point_id not in self._live:
            return False
        self._root, removed = remove(self._root, point_id)
        assert removed is not None
        del self._live[point_id]
        self.version += 1
        return True

    def replace(self, point_id: str, coords, labels=()) -> int:
        """Atomic version replace: re-insert with new coordinates/labels."""
        if point_id in self._live:
            self._root, _ = remove(self._root, point_id)
        point = self._check_coords(coords)
        entry = Entry(point_id, point, frozenset(labels))
        self._root = insert(self._root, entry, self.leaf_capacity)
        self._live[point_id] = None
        self.version += 1
        return self.version

    # --------------------------------------------------------------- queries

    def query(
        self,
        coords,
        k: int,
        filter_expr: Optional[dict] = None,
        budget: Optional[int] = None,
        version: Optional[int] = None,
    ) -> QueryResult:
        point = self._check_coords(coords)
        root = self._root_at(version)
        effective = self.version if version is None else version
        return search(root, point, k, filter_expr, budget, effective)

    def cursor_for(self, result: QueryResult, coords, k: int, filter_expr=None) -> Cursor:
        """Build a resumption cursor from an ``unknown`` (budget-exhausted) result."""
        if result.status != "unknown":
            raise ValueError("cursor only exists for budget-exhausted queries")
        return Cursor(
            version=result.version,
            k=k,
            query=self._check_coords(coords),
            filter_expr=filter_expr,
            frontier=tuple(result.resume_items),
            hits=tuple(result.resume_hits),
        )

    def resume(self, cursor: Cursor, budget: Optional[int] = None) -> QueryResult:
        """Continue an interrupted query.  Bound to the cursor's data version."""
        if cursor.version != self.version and cursor.version not in self._snapshots:
            raise StaleCursorError(
                f"cursor is bound to version {cursor.version}, "
                f"which is not available (current: {self.version})"
            )
        root = self._root_at(cursor.version)
        return search(
            root,
            cursor.query,
            cursor.k,
            cursor.filter_expr,
            budget,
            cursor.version,
            resume=(list(cursor.frontier), list(cursor.hits)),
        )

    # ------------------------------------------------------------- snapshots

    def snapshot(self) -> int:
        """Pin the current version; returns its version number."""
        self._snapshots[self.version] = self._root
        return self.version

    def release_snapshot(self, version: int) -> None:
        self._snapshots.pop(version, None)

    # ----------------------------------------------------------- persistence

    def save(self, path: str) -> None:
        data = {
            "format": FORMAT_VERSION,
            "dims": self.dims,
            "leaf_capacity": self.leaf_capacity,
            "version": self.version,
            "root": node_to_json(self._root),
            "snapshots": {str(v): node_to_json(r) for v, r in self._snapshots.items()},
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)

    @staticmethod
    def load(path: str) -> "KNNIndex":
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data["format"] != FORMAT_VERSION:
            raise ValueError(f"unsupported format version: {data['format']}")
        index = KNNIndex(data["dims"], data["leaf_capacity"])
        index.version = data["version"]
        index._root = node_from_json(data["root"])
        index._snapshots = {
            int(v): node_from_json(r) for v, r in data["snapshots"].items()
        }
        for entry in iter_entries(index._root):
            index._live[entry.point_id] = None
        return index

    # ------------------------------------------------------------------ misc

    def __len__(self) -> int:
        return len(self._live)

    def __contains__(self, point_id: str) -> bool:
        return point_id in self._live

    def get(self, point_id: str) -> Optional[Entry]:
        return find_entry(self._root, point_id)
