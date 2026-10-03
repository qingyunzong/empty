# rational-hull

Exact rational 2D **dynamic convex hull** with versioned snapshots, written
in pure Python 3.11 (standard library only).  Coordinates are
`fractions.Fraction` (always in lowest terms); no floating point is ever
used, so every geometric predicate is exact.

## Features

- **Dynamic updates** — `insert` / `delete` of id-tagged points; duplicate
  coordinates are allowed (multiset semantics), and deleting a point only
  changes the geometry when the *last* point at its coordinate disappears.
- **Local maintenance, never a full rescan** — points live in a persistent
  treap ordered by `(x, y, id)`.  Every node caches the canonical upper and
  lower convex chains of its subtree (a mergeable balanced-tree summary).
  An update rebuilds summaries only along the O(log n) search path; the
  built-in instrumentation (`hull.stats`) records visited-node counts per
  update so locality is auditable (see `tests/test_locality.py`).
- **Queries** — canonical CCW hull with per-edge half-plane evidence,
  directional extremes, tangents from an exterior point, point
  classification (`inside` / `boundary` / `outside`).
- **Versioning** — O(1) `snapshot()`, arbitrary `restore(version)`
  (nested snapshots, rollback, and branching history after rollback), plus
  a `push()` / `pop()` stack convenience.
- **Persistence** — exact JSON `save()` / `load()`; deterministic treap
  priorities (SHA-256 of the point key) make the reloaded structure
  identical to the saved one.
- **Independent checker** — `rational_hull.checker` verifies that every
  active point lies inside the reported hull, that every vertex is a real
  active point with the canonical id, that the polygon is strictly convex
  CCW, and that the per-edge half-plane evidence is correct.  A brute-force
  O(n^3) supporting-line enumeration serves as the reference hull.

## Canonical conventions

- Hull vertices are reported counter-clockwise, starting at the smallest
  `(x, y, id)`.
- Collinear points along an edge are never reported — only edge endpoints.
- At a shared coordinate the canonical representative is the smallest id.
- Directional-extreme ties: maximise `d·p`, then `d_perp·p` with
  `d_perp = (-dy, dx)`, then smallest id.
- Tangent ties (query point collinear with a hull edge): nearest vertex to
  the query point, then smallest id.

## Library API

```python
from rational_hull import DynamicConvexHull

h = DynamicConvexHull()
h.insert("a", 0, 0)            # ints, "p/q" strings, Fractions
h.insert("b", "7/2", 0)
h.insert("c", 2, 3)

res = h.hull()                 # res.vertices (CCW), res.edges
for e in res.edges:            # half-plane evidence: a*x + b*y + c >= 0
    print(e.p1.id, e.p2.id, e.a, e.b, e.c)

h.extreme(1, 1)                # farthest point in a direction
h.tangent(5, 1)                # (left, right) tangent vertices
h.contains_point(1, 1)         # 'inside' | 'boundary' | 'outside'

v = h.snapshot()               # O(1) version capture
h.delete("c")
h.restore(v)                   # rollback (versions never expire)
h.verify()                     # independent checker -> True
h.save("state.json")
h2 = DynamicConvexHull.load("state.json")
```

## JSON CLI

`python3.11 -m rational_hull` reads one JSON command per line on stdin and
answers one JSON object per line.  Coordinates are JSON integers or `"p/q"`
strings (floats are rejected to protect exactness).

```
$ printf '%s\n' \
    '{"op":"insert","id":"a","x":0,"y":0}' \
    '{"op":"insert","id":"b","x":4,"y":0}' \
    '{"op":"insert","id":"c","x":2,"y":3}' \
    '{"op":"hull"}' '{"op":"tangent","x":5,"y":1}' '{"op":"verify"}' \
  | python3.11 -m rational_hull
{"ok": true, "result": {"inserted": "a"}}
{"ok": true, "result": {"inserted": "b"}}
{"ok": true, "result": {"inserted": "c"}}
{"ok": true, "result": {"vertices": [{"id": "a", "x": "0", "y": "0"}, ...],
                        "edges": [{"p1": "a", "p2": "b", "a": 0, "b": 1, "c": 0}, ...]}}
{"ok": true, "result": {"left": {"id": "c", ...}, "right": {"id": "b", ...}}}
{"ok": true, "result": {"valid": true}}
```

Operations: `insert`, `delete`, `contains_id`, `get`, `count`, `hull`,
`extreme`, `tangent`, `contains_point`, `snapshot`, `restore`, `push`,
`pop`, `save`, `load`, `verify`, `stats`, `reset_stats`, `help`.

## Complexity

- Update: O(log n) treap nodes rebuilt (expected; deterministic hashed
  priorities), plus chain-repair work proportional to the merged chain
  fragments — never a re-sort or a full scan of the point set.
- Snapshot / restore: O(1).  `hull()`: O(h).  `extreme`: O(log h) via
  unimodal binary search on each chain.  `tangent` / `contains_point`:
  O(h) over the hull vertices only.

## Tests

```
python3.11 -m unittest discover -s tests -v
```

The suite (47 tests) covers: degenerate and all-collinear sets, duplicate
coordinates, deletion of extreme points bridging the two chains,
near-identical fractions that float64 cannot distinguish, nested snapshots
with rollback-and-fork, save/reload, checker negative tests, a randomised
cross-check against full supporting-line enumeration after *every* update,
and a long-update-sequence locality audit proving sublinear node visits.
Latest recorded run: see `TEST_RESULTS.txt`.
