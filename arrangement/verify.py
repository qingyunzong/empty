"""Independent verification of an arrangement's topology.

These checks re-derive their facts directly from the geometry and the
half-edge pointers (not from the construction code's own bookkeeping):

* every source segment is exactly covered by atomic edges,
* half-edges are paired twins with consistent next/prev links,
* every face ring is closed and every half-edge lies on exactly one face,
* the Euler relation V - E + F == C + C_e holds.
"""

from __future__ import annotations

from collections import defaultdict
from functools import cmp_to_key

from .geometry import angle_cmp, line_key, norm_dir


def verify_coverage(arrangement):
    """Each source segment is fully tiled by atomic edges of its line."""
    topo = arrangement.topology
    point_of = {v.id: v.point for v in topo.vertices}
    errors = []
    edges_by_line = {}
    for e in topo.edges:
        a, b = point_of[e.v0], point_of[e.v1]
        edges_by_line.setdefault(line_key(a, b), []).append((a, b))

    for sid, (p, q) in arrangement.segments.items():
        if p == q:
            if p not in (v.point for v in topo.vertices):
                errors.append(f"point segment {sid} at {p} has no vertex")
            continue
        dx, dy = norm_dir(p, q)
        t0, t1 = sorted((p[0] * dx + p[1] * dy, q[0] * dx + q[1] * dy))
        intervals = []
        for a, b in edges_by_line.get(line_key(p, q), []):
            ta, tb = sorted((a[0] * dx + a[1] * dy, b[0] * dx + b[1] * dy))
            lo, hi = max(ta, t0), min(tb, t1)
            if lo < hi:
                intervals.append((lo, hi))
        intervals.sort()
        cursor = t0
        for lo, hi in intervals:
            if lo > cursor:
                break
            cursor = max(cursor, hi)
        if cursor != t1:
            errors.append(
                f"segment {sid} ({p}->{q}) not covered up to {t1}; "
                f"reached {cursor}"
            )
    return errors


def verify_halfedges(arrangement):
    """Twins are paired and next/prev links are mutually consistent."""
    topo = arrangement.topology
    errors = []
    for h in topo.halfedges:
        t = h.twin
        if t is None or t.twin is not h:
            errors.append(f"half-edge {h.id} has a broken twin link")
            continue
        if t.origin != h.target or t.target != h.origin:
            errors.append(f"half-edge {h.id} twin endpoints mismatch")
        if h.next is None or h.next.prev is not h:
            errors.append(f"half-edge {h.id} has a broken next/prev link")
        if h.prev is None or h.prev.next is not h:
            errors.append(f"half-edge {h.id} has a broken prev/next link")
        if h.next is not None and h.next.origin != h.target:
            errors.append(f"half-edge {h.id} next does not start at target")
    return errors


def verify_faces(arrangement):
    """Every face ring closes and half-edges partition into faces."""
    topo = arrangement.topology
    errors = []
    seen = set()
    for face in topo.faces:
        ring = face.halfedges
        if not ring:
            errors.append(f"face {face.id} is empty")
            continue
        ids = {h.id for h in ring}
        if ring[-1].next is not ring[0]:
            errors.append(f"face {face.id} ring is not closed")
        for h in ring:
            if h.next not in ring:
                errors.append(f"face {face.id} ring broken at {h.id}")
            if h.face != face.id:
                errors.append(f"half-edge {h.id} face pointer mismatch")
            if h.id in seen:
                errors.append(f"half-edge {h.id} in two faces")
            seen.add(h.id)
        if len(ids) != len(ring):
            errors.append(f"face {face.id} repeats a half-edge")
    if seen != {h.id for h in topo.halfedges}:
        errors.append("some half-edges belong to no face")
    return errors


def verify_stitching(arrangement):
    """next(h) is the exact clockwise neighbour of twin(h) at its origin."""
    topo = arrangement.topology
    point_of = {v.id: v.point for v in topo.vertices}
    outgoing = defaultdict(list)
    for h in topo.halfedges:
        outgoing[h.origin].append(h)
    ordered_at = {}
    for vid, lst in outgoing.items():
        p = point_of[vid]

        def cmp(h1, h2):
            d1 = (point_of[h1.target][0] - p[0], point_of[h1.target][1] - p[1])
            d2 = (point_of[h2.target][0] - p[0], point_of[h2.target][1] - p[1])
            return angle_cmp(d1, d2)

        ordered_at[vid] = sorted(lst, key=cmp_to_key(cmp))
    errors = []
    for h in topo.halfedges:
        ordered = ordered_at[h.target]
        pos = {x.id: i for i, x in enumerate(ordered)}
        expected = ordered[(pos[h.twin.id] - 1) % len(ordered)]
        if h.next is not expected:
            errors.append(
                f"half-edge {h.id} next pointer violates angular order"
            )
    return errors


def verify_euler(arrangement):
    """V - E + F == C + C_e for the embedded planar graph."""
    topo = arrangement.topology
    lhs = topo.euler_value()
    rhs = topo.components + topo.components_with_edges
    if lhs != rhs:
        return [f"Euler relation violated: V-E+F={lhs} != C+C_e={rhs}"]
    return []


def verify_all(arrangement):
    """Run every check; returns a report dict (``ok`` is True iff clean)."""
    checks = {
        "coverage": verify_coverage(arrangement),
        "halfedges": verify_halfedges(arrangement),
        "faces": verify_faces(arrangement),
        "stitching": verify_stitching(arrangement),
        "euler": verify_euler(arrangement),
    }
    return {"ok": all(not v for v in checks.values()), "checks": checks}
