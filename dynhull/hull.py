"""Dynamic exact-rational 2D convex hull.

Points carry a unique id; several points may share one coordinate (the
geometry changes only when the last point at a coordinate is removed).

Tie-breaking rules (deterministic, documented):
  * hull vertex at a shared coordinate: the largest id represents it;
  * extreme(direction): max dot product, then smallest (x, y), then the
    smallest id among the points at that coordinate;
  * tangent points: among collinear candidates, smallest (x, y), then the
    smallest id at that coordinate.
"""
import json

from . import tree
from .geometry import ccw_vertices, cross, dot, to_fraction


class _State:
    __slots__ = ("root", "points", "by_coord", "shared")

    def __init__(self, root, points, by_coord, shared=False):
        self.root = root
        self.points = points          # id -> (Fraction x, Fraction y)
        self.by_coord = by_coord      # (x, y) -> set of ids
        self.shared = shared


def _chain_peak_candidates(chain, direction):
    """Chain vertices that may attain the max dot product on this chain.

    The dot product along a hull chain is unimodal up to one vertical end
    edge, so a ternary descent plus the two endpoints (plus the whole flat
    top, for exact tie-breaking) covers every maximizer.
    """
    n = len(chain)
    if n <= 4:
        return list(chain)
    cache = {}

    def val(i):
        if i not in cache:
            cache[i] = dot(direction, chain[i])
        return cache[i]

    lo, hi = 0, n - 1
    while hi - lo > 3:
        m1 = lo + (hi - lo) // 3
        m2 = hi - (hi - lo) // 3
        if val(m1) < val(m2):
            lo = m1 + 1
        else:
            hi = m2 - 1
    best = max(range(lo, hi + 1), key=lambda i: (val(i),))
    i = best
    while i - 1 >= 0 and val(i - 1) == val(best):
        i -= 1
    j = best
    while j + 1 < n and val(j + 1) == val(best):
        j += 1
    return [chain[0], chain[n - 1], chain[i], chain[j]]


class DynamicHull:
    def __init__(self):
        self._state = _State(None, {}, {})
        self._undo = []
        self.stats = {"visited": 0, "created": 0}
        self.last_op = {"visited": 0, "created": 0}

    # ------------------------------------------------------------------ #
    # internal helpers
    # ------------------------------------------------------------------ #
    def _mutable(self):
        st = self._state
        if st.shared:
            st = _State(st.root, dict(st.points),
                        {c: set(ids) for c, ids in st.by_coord.items()})
            self._state = st
        return st

    def _timed(self, fn):
        v0, c0 = self.stats["visited"], self.stats["created"]
        result = fn()
        self.last_op = {"visited": self.stats["visited"] - v0,
                        "created": self.stats["created"] - c0}
        return result

    # ------------------------------------------------------------------ #
    # updates
    # ------------------------------------------------------------------ #
    def insert(self, pid, x, y):
        fx, fy = to_fraction(x), to_fraction(y)
        if pid in self._state.points:
            raise ValueError(f"duplicate point id {pid!r}")
        st = self._mutable()
        key = (fx, fy, pid)
        st.root = self._timed(lambda: tree.insert(st.root, key, self.stats))
        st.points[pid] = (fx, fy)
        st.by_coord.setdefault((fx, fy), set()).add(pid)

    def delete(self, pid):
        st = self._state
        if pid not in st.points:
            raise KeyError(f"unknown point id {pid!r}")
        st = self._mutable()
        fx, fy = st.points.pop(pid)
        key = (fx, fy, pid)
        st.root = self._timed(lambda: tree.delete(st.root, key, self.stats))
        ids = st.by_coord[(fx, fy)]
        ids.discard(pid)
        if not ids:
            del st.by_coord[(fx, fy)]

    def __len__(self):
        return len(self._state.points)

    def __contains__(self, pid):
        return pid in self._state.points

    # ------------------------------------------------------------------ #
    # hull output
    # ------------------------------------------------------------------ #
    def _keys_ccw(self):
        root = self._state.root
        if root is None:
            return []
        return ccw_vertices(root.upper, root.lower)

    def vertices(self):
        """Canonical CCW vertices as a list of ``(id, x, y)``."""
        return [(k[2], k[0], k[1]) for k in self._keys_ccw()]

    def hull(self):
        """Vertices plus, for every edge, exact half-plane evidence.

        Each edge carries Fraction coefficients (a, b, c) such that every
        active point p satisfies ``a*p.x + b*p.y + c >= 0`` and both edge
        endpoints satisfy it with equality.
        """
        verts = self.vertices()
        m = len(verts)
        if m == 2:
            pairs = [(0, 1), (1, 0)]
        elif m >= 3:
            pairs = [(i, (i + 1) % m) for i in range(m)]
        else:
            pairs = []
        edges = []
        for i, j in pairs:
            _, ux, uy = verts[i]
            _, vx, vy = verts[j]
            a = -(vy - uy)
            b = vx - ux
            c = (vy - uy) * ux - (vx - ux) * uy
            edges.append({"from": verts[i][0], "to": verts[j][0],
                          "a": a, "b": b, "c": c})
        return {"vertices": [{"id": i, "x": x, "y": y} for i, x, y in verts],
                "edges": edges}

    # ------------------------------------------------------------------ #
    # queries
    # ------------------------------------------------------------------ #
    def extreme(self, dx, dy):
        """Point maximizing dx*x + dy*y, as ``(id, x, y)`` or None.

        Ties: smallest (x, y), then smallest id at that coordinate.
        """
        dx, dy = to_fraction(dx), to_fraction(dy)
        if dx == 0 and dy == 0:
            raise ValueError("zero direction")
        root = self._state.root
        if root is None:
            return None
        direction = (dx, dy)
        best = None
        for chain in (root.upper, root.lower):
            for key in _chain_peak_candidates(chain, direction):
                if best is None:
                    best = key
                    continue
                gain_new, gain_old = dot(direction, key), dot(direction, best)
                if (gain_new, -key[0], -key[1]) > (gain_old, -best[0], -best[1]):
                    best = key
        x, y = best[0], best[1]
        return (min(self._state.by_coord[(x, y)]), x, y)

    def tangents(self, qx, qy):
        """Tangent vertices from an external point q.

        Returns ``(left, right)`` where ``right`` is the tangent vertex t
        with the whole hull to the left of the ray q->t (cross >= 0) and
        ``left`` the mirror one.  Returns None if q is inside or on the
        hull.  For a degenerate hull (<= 2 vertices) returns the two
        endpoints.  Collinear ties: smallest (x, y), then smallest id.
        """
        q = (to_fraction(qx), to_fraction(qy))
        keys = self._keys_ccw()
        m = len(keys)
        if m == 0:
            return None
        if m <= 2:
            first, last = keys[0], keys[-1]
            return (self._as_point(first), self._as_point(last))
        if all(cross(keys[i], keys[(i + 1) % m], q) >= 0 for i in range(m)):
            return None  # q inside or on the boundary: no tangent
        right = [t for i, t in enumerate(keys)
                 if cross(q, t, keys[(i - 1) % m]) >= 0
                 and cross(q, t, keys[(i + 1) % m]) >= 0]
        left = [t for i, t in enumerate(keys)
                if cross(q, t, keys[(i - 1) % m]) <= 0
                and cross(q, t, keys[(i + 1) % m]) <= 0]
        return (self._as_point(min(left)), self._as_point(min(right)))

    def _as_point(self, key):
        x, y = key[0], key[1]
        return (min(self._state.by_coord[(x, y)]), x, y)

    # ------------------------------------------------------------------ #
    # snapshots / rollback (nested, LIFO)
    # ------------------------------------------------------------------ #
    def checkpoint(self):
        """Snapshot the current state; returns a token (stack depth)."""
        st = self._state
        st.shared = True
        self._undo.append(st)
        return len(self._undo)

    def rollback(self, token=None):
        """Restore the most recent checkpoint and discard it."""
        if not self._undo:
            raise RuntimeError("no checkpoint to roll back to")
        if token is not None and token != len(self._undo):
            raise ValueError("can only roll back the innermost checkpoint")
        self._state = self._undo.pop()

    def commit(self, token=None):
        """Discard the most recent checkpoint, keeping current state."""
        if not self._undo:
            raise RuntimeError("no checkpoint to commit")
        if token is not None and token != len(self._undo):
            raise ValueError("can only commit the innermost checkpoint")
        st = self._undo.pop()
        if self._state is st:
            st.shared = False

    # ------------------------------------------------------------------ #
    # persistence
    # ------------------------------------------------------------------ #
    def save(self, path):
        data = {"format": "dynhull/1",
                "points": [{"id": pid, "x": str(x), "y": str(y)}
                           for pid, (x, y) in sorted(
                               self._state.points.items(),
                               key=lambda kv: (repr(kv[0]),))]}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1, sort_keys=True)

    def load(self, path):
        """Replace the current state with the saved one (clears undo)."""
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("format") != "dynhull/1":
            raise ValueError("unrecognized save format")
        fresh = _State(None, {}, {})
        for rec in data["points"]:
            pid = rec["id"]
            fx, fy = to_fraction(rec["x"]), to_fraction(rec["y"])
            key = (fx, fy, pid)
            fresh.root = tree.insert(fresh.root, key, self.stats)
            fresh.points[pid] = (fx, fy)
            fresh.by_coord.setdefault((fx, fy), set()).add(pid)
        self._state = fresh
        self._undo.clear()

    def reset_stats(self):
        self.stats = {"visited": 0, "created": 0}
        self.last_op = {"visited": 0, "created": 0}
