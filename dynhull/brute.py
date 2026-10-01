"""Independent O(n^3) reference implementations used by the test-suite.

These share no code with the dynamic structure: the hull is derived by
enumerating every ordered pair of points and keeping the supporting
lines, so agreement between the two is strong evidence of correctness.
"""
from .geometry import cross, dot


def _rep_keys(points):
    """One canonical key per coordinate: the largest id represents it."""
    coord_id = {}
    for pid, (x, y) in points.items():
        coord = (x, y)
        if coord not in coord_id or pid > coord_id[coord]:
            coord_id[coord] = pid
    return sorted((x, y, pid) for (x, y), pid in coord_id.items())


def _beyond(a, b, c):
    """True if c is collinear with a->b and strictly past b."""
    return ((c[0] - b[0]) * (b[0] - a[0]) + (c[1] - b[1]) * (b[1] - a[1])) > 0


def brute_hull_vertices(points):
    """Canonical CCW vertices as [(id, x, y)], by full pair enumeration."""
    keys = _rep_keys(points)
    if len(keys) <= 2:
        return [(k[2], k[0], k[1]) for k in keys]
    adjacency = {}
    for a in keys:
        for b in keys:
            if a is b:
                continue
            ok = True
            for c in keys:
                if c is a or c is b:
                    continue
                cr = cross(a, b, c)
                if cr < 0 or (cr == 0 and _beyond(a, b, c)):
                    ok = False
                    break
            if ok:
                adjacency.setdefault(a, []).append(b)
    start = keys[0]
    order = [start]
    current = start
    while True:
        nxt = adjacency[current][0]
        if nxt is start:
            break
        order.append(nxt)
        current = nxt
    return [(k[2], k[0], k[1]) for k in order]


def brute_extreme(points, direction):
    """(id, x, y) maximizing dot; ties: smallest (x, y), then smallest id."""
    if not points:
        return None
    best_val = max(dot(direction, p) for p in points.values())
    x, y = min(p for p in points.values() if dot(direction, p) == best_val)
    pid = min(i for i, p in points.items() if p == (x, y))
    return (pid, x, y)


def brute_tangents(points, q):
    """(left, right) tangent vertices, or None when q is inside/on hull."""
    verts = brute_hull_vertices(points)
    m = len(verts)
    if m == 0:
        return None
    if m <= 2:
        return (verts[0], verts[-1])
    keys = [(x, y, pid) for pid, x, y in verts]
    if all(cross(keys[i], keys[(i + 1) % m], q) >= 0 for i in range(m)):
        return None
    right = [k for k in keys if all(cross(q, k, v) >= 0 for v in keys)]
    left = [k for k in keys if all(cross(q, k, v) <= 0 for v in keys)]

    def pick(candidates):
        x, y = min((k[0], k[1]) for k in candidates)
        pid = min(i for i, p in points.items() if p == (x, y))
        return (pid, x, y)

    return (pick(left), pick(right))
