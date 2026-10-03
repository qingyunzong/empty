"""Dynamic convex hull over exact rational points.

Supports insert/delete of id-tagged points (duplicate coordinates allowed),
tangent and directional-extreme queries, nested snapshots with rollback
(persistent structure => O(1) version capture, branching history), and
JSON save/load.  All arithmetic is exact rational arithmetic.

Canonical conventions
----------------------
* Hull vertices are reported counter-clockwise, starting at the vertex with
  the smallest (x, y, id).
* Collinear points along an edge are never reported: only edge endpoints.
* At a shared coordinate the canonical representative is the smallest id.
* Directional extreme ties: maximise d.p, then d_perp.p with
  d_perp = (-dy, dx), then smallest id.
* Tangent ties (query point collinear with a hull edge): nearest vertex to
  the query point, then smallest id.
"""

from __future__ import annotations

import json
from collections import namedtuple
from fractions import Fraction

from . import treap
from .geometry import Point, dist2, edge_coefficients, orient, orient_sign

Edge = namedtuple("Edge", ["p1", "p2", "a", "b", "c"])


class HullResult:
    """CCW canonical vertices plus per-edge inward half-plane evidence."""

    __slots__ = ("vertices", "edges")

    def __init__(self, vertices, edges):
        self.vertices = tuple(vertices)
        self.edges = tuple(edges)

    def __len__(self):
        return len(self.vertices)

    def __iter__(self):
        return iter(self.vertices)

    def __eq__(self, other):
        return (
            isinstance(other, HullResult)
            and self.vertices == other.vertices
            and self.edges == other.edges
        )

    def __repr__(self):
        return f"HullResult(vertices={list(self.vertices)!r})"


class Version:
    """Opaque handle to a historical state (nested / branching friendly)."""

    __slots__ = ("_root", "_points", "stamp")

    def __init__(self, root, points, stamp):
        self._root = root
        self._points = points
        self.stamp = stamp

    def __repr__(self):
        return f"Version(stamp={self.stamp})"


class HullStats:
    """Cumulative instrumentation distinguishing local vs full maintenance."""

    __slots__ = (
        "updates",
        "nodes_visited",
        "chain_steps",
        "max_update_nodes",
        "max_update_chain_steps",
        "last_update_nodes",
        "last_update_chain_steps",
    )

    def __init__(self):
        self.reset()

    def reset(self):
        self.updates = 0
        self.nodes_visited = 0
        self.chain_steps = 0
        self.max_update_nodes = 0
        self.max_update_chain_steps = 0
        self.last_update_nodes = 0
        self.last_update_chain_steps = 0

    def record(self, ctr):
        self.updates += 1
        self.nodes_visited += ctr.nodes_visited
        self.chain_steps += ctr.chain_steps
        self.last_update_nodes = ctr.nodes_visited
        self.last_update_chain_steps = ctr.chain_steps
        if ctr.nodes_visited > self.max_update_nodes:
            self.max_update_nodes = ctr.nodes_visited
        if ctr.chain_steps > self.max_update_chain_steps:
            self.max_update_chain_steps = ctr.chain_steps

    def to_dict(self):
        return {name: getattr(self, name) for name in self.__slots__}


def as_fraction(value) -> Fraction:
    """Coerce an exact rational literal to ``Fraction`` (floats rejected)."""
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise TypeError("booleans are not valid coordinates")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, str):
        text = value.strip()
        try:
            return Fraction(text)
        except ValueError as exc:
            raise ValueError(f"invalid rational literal: {value!r}") from exc
    if isinstance(value, (tuple, list)) and len(value) == 2:
        return Fraction(int(value[0]), int(value[1]))
    if isinstance(value, dict) and "num" in value and "den" in value:
        return Fraction(int(value["num"]), int(value["den"]))
    raise TypeError(
        f"unsupported coordinate type {type(value).__name__}; "
        "use an int or a 'p/q' string (floats are not exact)"
    )


def _chain_argmax(chain, dx, dy):
    """Vertices of an x-monotone chain maximising dx*x + dy*y (a plateau)."""
    n = len(chain)

    def value(i):
        return dx * chain[i].x + dy * chain[i].y

    lo, hi = 0, n - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if value(mid) < value(mid + 1):
            lo = mid + 1
        else:
            hi = mid
    out = [chain[lo]]
    j = lo + 1
    while j < n and value(j) == value(lo):
        out.append(chain[j])
        j += 1
    return out


class DynamicConvexHull:
    """A dynamic, versioned convex hull of rational points with unique ids."""

    SAVE_FORMAT = "rational-hull/1"

    def __init__(self):
        self._root = None
        self._points = {}
        self._shared = False
        self._stack = []
        self._stamp = 0
        self.stats = HullStats()

    # ------------------------------------------------------------------ size
    def __len__(self):
        return len(self._points)

    def __contains__(self, pid):
        return pid in self._points

    def get(self, pid) -> Point:
        return self._points[pid]

    def points(self):
        """All active points, sorted by (x, y, id)."""
        return sorted(self._points.values(), key=lambda p: p.key())

    # --------------------------------------------------------------- updates
    def _mutable_points(self):
        if self._shared:
            self._points = dict(self._points)
            self._shared = False

    def insert(self, pid, x, y):
        """Insert a point.  ``pid`` must be a fresh string id."""
        if not isinstance(pid, str):
            raise TypeError("point id must be a string")
        self._mutable_points()
        if pid in self._points:
            raise ValueError(f"duplicate point id: {pid!r}")
        point = Point(pid, as_fraction(x), as_fraction(y))
        self._points[pid] = point
        ctr = treap.UpdateCounter()
        self._root = treap.insert(self._root, point, ctr)
        self.stats.record(ctr)
        return point

    def delete(self, pid):
        """Delete a point by id.  Geometry only changes when the last point
        at its coordinate disappears."""
        self._mutable_points()
        point = self._points[pid]  # KeyError if absent
        del self._points[pid]
        ctr = treap.UpdateCounter()
        self._root = treap.delete(self._root, point.key(), ctr)
        self.stats.record(ctr)
        return point

    # ----------------------------------------------------------------- hull
    def hull(self) -> HullResult:
        """Canonical CCW vertices with per-edge half-plane evidence."""
        if self._root is None:
            return HullResult((), ())
        combined = list(self._root.lower) + list(reversed(self._root.upper))
        verts = []
        for p in combined:
            if verts and verts[-1].coord() == p.coord():
                continue
            verts.append(p)
        if len(verts) > 1 and verts[0].coord() == verts[-1].coord():
            verts.pop()
        start = min(
            range(len(verts)),
            key=lambda i: (verts[i].x, verts[i].y, verts[i].id),
        )
        verts = verts[start:] + verts[:start]
        edges = []
        m = len(verts)
        if m >= 2:
            for i in range(m):
                a = verts[i]
                b = verts[(i + 1) % m]
                ca, cb, cc = edge_coefficients(a, b)
                edges.append(Edge(a, b, ca, cb, cc))
        return HullResult(verts, edges)

    # --------------------------------------------------------------- queries
    def extreme(self, dx, dy) -> Point:
        """Point maximising dx*x + dy*y (ties: d_perp, then smallest id)."""
        dx = as_fraction(dx)
        dy = as_fraction(dy)
        if dx == 0 and dy == 0:
            raise ValueError("zero direction vector")
        if self._root is None:
            raise ValueError("empty hull")
        candidates = []
        if dy >= 0:
            candidates.extend(_chain_argmax(self._root.upper, dx, dy))
        if dy <= 0:
            candidates.extend(_chain_argmax(self._root.lower, dx, dy))
        best = None
        best_key = None
        for p in candidates:
            key = (dx * p.x + dy * p.y, -dy * p.x + dx * p.y)
            if (
                best is None
                or key > best_key
                or (key == best_key and p.id < best.id)
            ):
                best = p
                best_key = key
        return best

    def contains_point(self, x, y) -> str:
        """Classify a query point: 'inside', 'boundary' or 'outside'."""
        qx = as_fraction(x)
        qy = as_fraction(y)
        verts = self.hull().vertices
        m = len(verts)
        if m == 0:
            return "outside"
        if m == 1:
            v = verts[0]
            return "boundary" if (v.x, v.y) == (qx, qy) else "outside"
        q = Point("", qx, qy)
        if m == 2:
            a, b = verts
            if orient_sign(a, b, q) != 0:
                return "outside"
            if (
                min(a.x, b.x) <= qx <= max(a.x, b.x)
                and min(a.y, b.y) <= qy <= max(a.y, b.y)
            ):
                return "boundary"
            return "outside"
        sign = 0
        for i in range(m):
            cross = orient_sign(verts[i], verts[(i + 1) % m], q)
            if cross < 0:
                return "outside"
            if cross == 0:
                sign |= 1
            else:
                sign |= 2
        return "boundary" if sign & 1 else "inside"

    def tangent(self, x, y):
        """Tangent vertices from a strictly exterior query point.

        Returns ``(left, right)``: ``left`` has the whole hull in the closed
        left half-plane of the ray from q through it, ``right`` in the closed
        right half-plane.  Ties (q collinear with a hull edge) resolve to the
        nearest vertex to q, then the smallest id.
        """
        q = Point("", as_fraction(x), as_fraction(y))
        verts = self.hull().vertices
        m = len(verts)
        if m < 3:
            raise ValueError("tangent query needs a non-degenerate hull")
        if self.contains_point(q.x, q.y) != "outside":
            raise ValueError("query point must be strictly outside the hull")
        left_cands = []
        right_cands = []
        for i in range(m):
            o_prev = orient_sign(q, verts[i], verts[i - 1])
            o_next = orient_sign(q, verts[i], verts[(i + 1) % m])
            if o_prev >= 0 and o_next >= 0:
                left_cands.append(verts[i])
            if o_prev <= 0 and o_next <= 0:
                right_cands.append(verts[i])
        pick = lambda cands: min(cands, key=lambda p: (dist2(q, p), p.id))
        return (pick(left_cands), pick(right_cands))

    # -------------------------------------------------------------- versions
    def snapshot(self) -> Version:
        """Capture the current state in O(1); stays valid forever."""
        self._shared = True
        self._stamp += 1
        return Version(self._root, self._points, self._stamp)

    def restore(self, version: Version):
        """Roll back (or forward) to any previously captured version."""
        if not isinstance(version, Version):
            raise TypeError("expected a Version returned by snapshot()")
        self._root = version._root
        self._points = version._points
        self._shared = True

    def push(self):
        """Stack-based convenience for nested snapshots."""
        self._stack.append(self.snapshot())
        return self._stack[-1]

    def pop(self):
        """Restore the most recently pushed snapshot."""
        if not self._stack:
            raise IndexError("no pushed snapshot to pop")
        version = self._stack.pop()
        self.restore(version)
        return version

    # ---------------------------------------------------------- persistence
    def save(self, path):
        """Serialise the current state as JSON (exact 'p/q' strings)."""
        data = {
            "format": self.SAVE_FORMAT,
            "points": [
                {"id": p.id, "x": str(p.x), "y": str(p.y)}
                for p in sorted(self._points.values(), key=lambda p: p.id)
            ],
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.write("\n")

    @classmethod
    def load(cls, path):
        """Rebuild from :meth:`save`.  Deterministic priorities make the
        reloaded tree (and every chain summary) identical to the saved one."""
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("format") != cls.SAVE_FORMAT:
            raise ValueError(f"unsupported format: {data.get('format')!r}")
        hull = cls()
        for rec in data["points"]:
            hull.insert(rec["id"], rec["x"], rec["y"])
        return hull

    # ------------------------------------------------------------ validation
    def verify(self):
        """Run the independent checker over the current state."""
        from .checker import verify

        return verify(self)
