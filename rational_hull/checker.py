"""Independent verifier and brute-force reference implementation.

This module deliberately shares *no* code with the dynamic data structure
(only the exact ``orient`` primitive).  ``brute_force_hull`` computes the
canonical hull by full enumeration of supporting lines over all active
points -- O(n^3) -- and ``verify_hull`` independently validates a
``HullResult``: every vertex is a real active point with the canonical id,
the polygon is strictly convex CCW, the per-edge half-plane evidence matches
the edge geometry, and every active point satisfies every half-plane (i.e.
lies inside or on the hull).
"""

from __future__ import annotations

from .geometry import Point, edge_coefficients, orient


class VerificationError(AssertionError):
    """Raised when a hull fails independent verification."""


def brute_force_hull(points):
    """Canonical CCW vertex coordinates via full supporting-line enumeration.

    ``points`` is an iterable of ``Point``.  Returns the list of ``(x, y)``
    coordinates of the canonical hull (collinear edge interiors excluded),
    starting at the smallest coordinate, counter-clockwise.
    """
    coords = sorted({(p.x, p.y) for p in points})
    if len(coords) <= 1:
        return coords

    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    # Full enumeration: (a, b) is a directed CCW hull edge iff every other
    # point lies in the closed left half-plane of a -> b.
    nxt = {}
    for a in coords:
        for b in coords:
            if a == b:
                continue
            if all(cross(a, b, c) >= 0 for c in coords):
                nxt.setdefault(a, []).append(b)
    start = coords[0]
    out = [start]
    cur = start
    while True:
        candidates = nxt.get(cur)
        if not candidates:
            raise VerificationError(f"open hull boundary at {cur}")
        # Among collinear candidates keep only the farthest endpoint.
        nxt_pt = max(
            candidates,
            key=lambda v: (v[0] - cur[0]) ** 2 + (v[1] - cur[1]) ** 2,
        )
        if nxt_pt == start:
            break
        out.append(nxt_pt)
        cur = nxt_pt
        if len(out) > len(coords):
            raise VerificationError("hull boundary walk did not close")
    return out


def canonical_vertices(points):
    """Canonical CCW ``Point`` vertices (min id representative per coord)."""
    reps = {}
    for p in points:
        key = (p.x, p.y)
        if key not in reps or p.id < reps[key]:
            reps[key] = p.id
    return [
        Point(reps[coord], coord[0], coord[1])
        for coord in brute_force_hull(points)
    ]


def verify_hull(hull, points):
    """Independently verify a ``HullResult`` against the active points.

    Returns True; raises :class:`VerificationError` on any violation.
    """
    verts = list(hull.vertices)
    by_id = {}
    by_coord = {}
    for p in points:
        by_id[p.id] = p
        by_coord.setdefault((p.x, p.y), []).append(p.id)

    # 1. Every vertex is a real active point with matching coordinates.
    for v in verts:
        if v.id not in by_id:
            raise VerificationError(f"vertex id {v.id!r} is not active")
        p = by_id[v.id]
        if (p.x, p.y) != (v.x, v.y):
            raise VerificationError(
                f"vertex {v.id!r} coordinate mismatch: "
                f"{(v.x, v.y)} vs {(p.x, p.y)}"
            )

    # 2. Canonical representative: smallest id at each vertex coordinate.
    for v in verts:
        want = min(by_coord[(v.x, v.y)])
        if v.id != want:
            raise VerificationError(
                f"vertex at {(v.x, v.y)} uses id {v.id!r}, expected {want!r}"
            )

    # 3. Vertex coordinates are distinct.
    coords = [(v.x, v.y) for v in verts]
    if len(set(coords)) != len(coords):
        raise VerificationError("duplicate vertex coordinates")

    m = len(verts)

    # 4. Strict CCW convexity (no collinear consecutive triples).
    if m >= 3:
        for i in range(m):
            if orient(verts[i], verts[(i + 1) % m], verts[(i + 2) % m]) <= 0:
                raise VerificationError(
                    f"non-convex or clockwise turn at vertex {i}"
                )

    # 5. Half-plane evidence: coefficients match the edge and every active
    #    point satisfies every inward half-plane (hence lies in the hull).
    expected_edges = m if m >= 2 else 0
    if len(hull.edges) != expected_edges:
        raise VerificationError(
            f"expected {expected_edges} edges, got {len(hull.edges)}"
        )
    for i, edge in enumerate(hull.edges):
        a = verts[i]
        b = verts[(i + 1) % m]
        if edge.p1.id != a.id or edge.p2.id != b.id:
            raise VerificationError(f"edge {i} endpoints mismatch")
        if (edge.a, edge.b, edge.c) != edge_coefficients(a, b):
            raise VerificationError(f"edge {i} evidence coefficients wrong")
        for p in points:
            if edge.a * p.x + edge.b * p.y + edge.c < 0:
                raise VerificationError(
                    f"active point {p.id!r} violates half-plane of edge {i}"
                )

    # 6. Degenerate hulls: containment must be checked directly.
    if m == 0 and points:
        raise VerificationError("empty hull but active points exist")
    if m == 1:
        for p in points:
            if (p.x, p.y) != coords[0]:
                raise VerificationError(
                    f"active point {p.id!r} outside degenerate hull"
                )
    if m == 2:
        a, b = verts
        for p in points:
            if orient(a, b, p) != 0:
                raise VerificationError(
                    f"active point {p.id!r} not collinear with segment hull"
                )
            if not (
                min(a.x, b.x) <= p.x <= max(a.x, b.x)
                and min(a.y, b.y) <= p.y <= max(a.y, b.y)
            ):
                raise VerificationError(
                    f"active point {p.id!r} beyond segment hull endpoints"
                )
    return True


def verify(dynamic_hull):
    """Verify the current state of a ``DynamicConvexHull``."""
    return verify_hull(dynamic_hull.hull(), dynamic_hull.points())
