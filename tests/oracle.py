"""Independent brute-force reference implementation for tests.

Computes split points by exact pairwise intersection of atomic segments
(no sweep line) and cuts atoms at those points.  Used as an oracle to
cross-check the sweep-line construction on small inputs.
"""

from __future__ import annotations

from arrangement.geometry import line_key, on_segment, segment_intersection_point
from arrangement.sweep import atomic_decomposition, split_atoms


def reference_edges(segments):
    """segments: iterable of (p, q, sid). Returns sorted edge tuples."""
    normal = [(p, q, sid) for p, q, sid in segments if p != q]
    points = {p for p, q, sid in segments if p == q}
    atoms, _ = atomic_decomposition(normal)
    splits = {a.index: {a.p, a.q} for a in atoms}
    for i, a in enumerate(atoms):
        for b in atoms[i + 1:]:
            if line_key(a.p, a.q) == line_key(b.p, b.q):
                continue  # collinear atoms are interior-disjoint already
            pt = segment_intersection_point(a.p, a.q, b.p, b.q)
            if pt is not None:
                splits[a.index].add(pt)
                splits[b.index].add(pt)
    for r in points:
        for a in atoms:
            if r != a.p and r != a.q and on_segment(r, a.p, a.q):
                splits[a.index].add(r)
    edges = split_atoms(atoms, splits)
    return sorted((min(p, q), max(p, q), frozenset(s)) for p, q, s in edges)


def sweep_edges(arrangement):
    """Canonical edge tuples from a built Arrangement."""
    point_of = {v.id: v.point for v in arrangement.topology.vertices}
    return sorted(
        (
            min(point_of[e.v0], point_of[e.v1]),
            max(point_of[e.v0], point_of[e.v1]),
            frozenset(e.sources),
        )
        for e in arrangement.edges
    )
