"""Canonical atomic segments and exact sweep-line intersection detection.

Pipeline:

1. ``atomic_decomposition`` merges collinear overlaps into canonical
   non-overlapping atomic segments, each carrying the set of source
   segment ids that cover it.
2. ``sweep_intersections`` runs a Bentley-Ottmann style sweep with an
   event queue and an active-order status structure (all comparisons
   exact) to find every intersection point.  Vertical segments are
   handled by an exact y-range query against the status at their x.
3. ``split_atoms`` cuts the atomic segments at every split point,
   producing the final traversable edges.
"""

from __future__ import annotations

import heapq
from collections import defaultdict
from fractions import Fraction
from functools import cmp_to_key

from .geometry import (
    line_intersection,
    line_key,
    norm_dir,
    on_segment,
)


class Atom:
    """A canonical segment with a set of covering source segment ids."""

    __slots__ = ("p", "q", "sources", "index")

    def __init__(self, p, q, sources, index):
        self.p = p
        self.q = q
        self.sources = frozenset(sources)
        self.index = index

    def __repr__(self):  # pragma: no cover - debugging aid
        return f"Atom({self.p}, {self.q}, {sorted(self.sources)})"


def atomic_decomposition(segments):
    """Merge collinear overlaps into canonical atomic segments.

    ``segments`` is an iterable of ``(p, q, source_id)`` with p != q.
    Returns ``(atoms, extra_points)`` where atoms are interior-disjoint
    and each carries the set of source ids covering it.
    """
    groups = defaultdict(list)
    for p, q, sid in segments:
        groups[line_key(p, q)].append((p, q, sid))

    atoms = []
    for key in sorted(groups):
        group = groups[key]
        dx, dy = norm_dir(group[0][0], group[0][1])

        def t_of(pt):
            return pt[0] * dx + pt[1] * dy

        point_at = {}
        intervals = []
        for p, q, sid in group:
            tp, tq = t_of(p), t_of(q)
            if tp > tq:
                tp, tq = tq, tp
            point_at[tp] = p if t_of(p) == tp else q
            point_at[tq] = q if t_of(q) == tq else p
            intervals.append((tp, tq, sid))
        ts = sorted(point_at)
        for lo, hi in zip(ts, ts[1:]):
            if lo == hi:
                continue
            mid = (lo + hi) / 2
            sources = {sid for a, b, sid in intervals if a <= mid <= b}
            atoms.append(Atom(point_at[lo], point_at[hi], sources, len(atoms)))
    return atoms, []


class _SweepSegment:
    """Non-vertical segment in the sweep status; left endpoint p, right q."""

    __slots__ = ("p", "q", "index", "slope", "intercept", "dx", "dy")

    def __init__(self, p, q, index):
        self.p = p
        self.q = q
        self.index = index
        self.dx = q[0] - p[0]
        self.dy = q[1] - p[1]
        self.slope = self.dy / self.dx
        self.intercept = p[1] - self.slope * p[0]

    def y_at(self, x):
        return self.slope * x + self.intercept


def _slope_cmp(a: _SweepSegment, b: _SweepSegment) -> int:
    """Exact order of two segments just right of a common event point."""
    lhs = a.dy * b.dx
    rhs = b.dy * a.dx
    if lhs != rhs:
        return -1 if lhs < rhs else 1
    return (a.index > b.index) - (a.index < b.index)


def sweep_intersections(atoms, extra_points=()):
    """Sweep ``atoms`` and return ``(splits, intersection_points)``.

    ``splits`` maps atom index -> set of exact points (endpoints plus
    every discovered intersection).  ``extra_points`` are forced split
    locations (e.g. zero-length point segments lying on an atom).
    """
    normals = []  # _SweepSegment
    verticals = []  # (x, y_lo, y_hi, atom index)
    splits = {a.index: {a.p, a.q} for a in atoms}
    endpoints_by_x = defaultdict(list)

    for atom in atoms:
        p, q = atom.p, atom.q
        if p == q:
            continue
        if q < p:
            p, q = q, p
        if p[0] == q[0]:
            verticals.append((p[0], p[1], q[1], atom.index))
        else:
            normals.append(_SweepSegment(p, q, atom.index))
            endpoints_by_x[p[0]].append(p)
            endpoints_by_x[q[0]].append(q)

    starts = defaultdict(list)
    vertical_at = defaultdict(list)
    pushed = set()

    def push_event(pt):
        if pt not in pushed:
            pushed.add(pt)
            heapq.heappush(heap, pt)

    heap = []
    for seg in normals:
        starts[seg.p].append(seg)
        push_event(seg.p)
        push_event(seg.q)
    for x, y_lo, y_hi, idx in verticals:
        vertical_at[(x, y_lo)].append((x, y_lo, y_hi, idx))
        push_event((x, y_lo))
        push_event((x, y_hi))

    status = []  # _SweepSegment ordered by y at the current sweep x
    intersections = set()

    def find_block(pt):
        """Contiguous [lo, hi) range of status segments through pt."""
        lo, hi = 0, len(status)
        # lower bound: first index with y_at(pt.x) >= pt.y
        a, b = 0, len(status)
        while a < b:
            m = (a + b) // 2
            if status[m].y_at(pt[0]) < pt[1]:
                a = m + 1
            else:
                b = m
        lo = a
        hi = lo
        while hi < len(status) and status[hi].y_at(pt[0]) == pt[1]:
            hi += 1
        return lo, hi

    def check_pair(i, cur_x):
        """Test status neighbours i, i+1 for a future intersection."""
        if i < 0 or i + 1 >= len(status):
            return
        a, b = status[i], status[i + 1]
        pt = line_intersection(a.p, a.q, b.p, b.q)
        if pt is None:
            return
        if pt[0] <= cur_x:
            return
        if pt[0] > a.q[0] or pt[0] > b.q[0]:
            return
        if not (on_segment(pt, a.p, a.q) and on_segment(pt, b.p, b.q)):
            return
        push_event(pt)

    processed = set()
    while heap:
        pt = heapq.heappop(heap)
        if pt in processed:
            continue
        processed.add(pt)

        # --- regular event: reorder the block of segments through pt ---
        lo, hi = find_block(pt)
        block = status[lo:hi]
        continuing = [s for s in block if s.q != pt]
        beginning = starts.get(pt, [])
        meeting = block + beginning
        if len(meeting) >= 2:
            intersections.add(pt)
        for s in continuing:
            splits[s.index].add(pt)

        new_block = sorted(continuing + beginning, key=cmp_to_key(_slope_cmp))
        status[lo:hi] = new_block
        cur_x = pt[0]
        check_pair(lo - 1, cur_x)
        check_pair(lo + len(new_block) - 1, cur_x)

        # --- vertical segments whose sweep x we have reached ---
        for x, y_lo, y_hi, idx in vertical_at.get(pt, ()):
            hits = []
            for s in status:
                y = s.y_at(x)
                if y_lo <= y <= y_hi:
                    hits.append((x, y))
                    splits[s.index].add((x, y))
            for ep in endpoints_by_x.get(x, ()):
                if y_lo <= ep[1] <= y_hi:
                    hits.append(ep)
            for h in hits:
                splits[idx].add(h)
                intersections.add(h)

    # forced split points (e.g. point segments on an atom's interior)
    atom_by_index = {a.index: a for a in atoms}
    for r in extra_points:
        for atom in atoms:
            if r == atom.p or r == atom.q:
                continue
            if on_segment(r, atom.p, atom.q):
                splits[atom.index].add(r)
                intersections.add(r)

    return splits, intersections


def split_atoms(atoms, splits):
    """Cut atoms at their split points into final edges.

    Returns a list of ``(p, q, sources)`` with p < q, covering every
    atom exactly once.
    """
    edges = []
    for atom in atoms:
        pts = splits.get(atom.index) or {atom.p, atom.q}
        ordered = sorted(pts)
        for a, b in zip(ordered, ordered[1:]):
            if a != b:
                edges.append((a, b, atom.sources))
    return edges
