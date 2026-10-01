"""Independent verifier: checks a reported hull against the active points.

Confirms that every reported vertex really exists among the active
points, that the vertex cycle is strictly convex, canonical and CCW, and
that every edge's half-plane evidence holds for all active points.
"""
from .geometry import cross


def _edge_coeffs(u, v):
    a = -(v[1] - u[1])
    b = v[0] - u[0]
    c = (v[1] - u[1]) * u[0] - (v[0] - u[0]) * u[1]
    return a, b, c


def verify(points, hull_obj):
    """Return True iff ``hull_obj`` is the exact hull of ``points``.

    ``points``: dict id -> (Fraction, Fraction).
    ``hull_obj``: the dict produced by :meth:`DynamicHull.hull`.
    """
    verts = [(v["id"], v["x"], v["y"]) for v in hull_obj["vertices"]]
    edges = hull_obj["edges"]
    m = len(verts)
    for pid, x, y in verts:
        if pid not in points or points[pid] != (x, y):
            return False  # vertex must really exist
    coords = [(x, y) for _, x, y in verts]
    if len(set(coords)) != m:
        return False
    if m == 0:
        return not points and not edges
    if m == 1:
        return all(p == coords[0] for p in points.values()) and not edges
    if verts[0] != min(verts, key=lambda t: (t[1], t[2], t[0])):
        return False  # canonical start: smallest (x, y, id)
    if m == 2:
        (i0, x0, y0), (i1, x1, y1) = verts
        for x, y in points.values():
            if cross((x0, y0), (x1, y1), (x, y)) != 0:
                return False
            if not (min(x0, x1) <= x <= max(x0, x1)
                    and min(y0, y1) <= y <= max(y0, y1)):
                return False
        want = {_edge_coeffs((x0, y0), (x1, y1)),
                _edge_coeffs((x1, y1), (x0, y0))}
        got = {(e["a"], e["b"], e["c"]) for e in edges}
        pairs = {(e["from"], e["to"]) for e in edges}
        return len(edges) == 2 and want == got and pairs == {(i0, i1), (i1, i0)}
    keys = [(x, y, pid) for pid, x, y in verts]
    for i in range(m):
        if cross(keys[i - 1], keys[i], keys[(i + 1) % m]) <= 0:
            return False  # strictly convex CCW, no collinear vertices
    if len(edges) != m:
        return False
    for i, e in enumerate(edges):
        uid, ux, uy = verts[i]
        vid, vx, vy = verts[(i + 1) % m]
        if e["from"] != uid or e["to"] != vid:
            return False
        a, b, c = _edge_coeffs((ux, uy), (vx, vy))
        if (e["a"], e["b"], e["c"]) != (a, b, c):
            return False
        if a == 0 and b == 0:
            return False
        for x, y in points.values():
            if a * x + b * y + c < 0:
                return False  # every active point inside the half-plane
    return True
