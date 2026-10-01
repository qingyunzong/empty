# arrangement — 有理坐标线段平面排列构造器

Exact planar-arrangement construction for line segments with rational
coordinates.  Pure Python 3.11 standard library (`fractions.Fraction`
everywhere; no floating point, no `atan`).

## Pipeline

1. **Atomic decomposition** (`arrangement/atomic.py`) — input segments
   are grouped by their (exactly normalised) supporting line; a 1D
   sweep per line emits canonical non-overlapping atomic segments, each
   carrying the set of source segment ids.  Zero-length segments become
   point records.
2. **Sweep line** (`arrangement/sweep.py`) — an exact Bentley–Ottmann
   sweep (event priority queue + ordered active status, events at the
   same point processed as one group) finds every point where two or
   more atomic segments meet: proper crossings, T-junctions, shared
   endpoints, multi-segment concurrence.  Vertical segments are handled
   by an exact range query over the status.  Intersections are
   discovered between status neighbours only — never by pairwise
   enumeration.
3. **Splitting + DCEL** (`arrangement/dcel.py`) — atoms are split at
   all sweep/point-segment points; twin half-edges are created per
   edge; outgoing half-edges around every vertex are ordered by an
   exact angular predicate (half-plane + cross product); face boundary
   cycles are walked, classified by exact signed area, holes are
   grouped into their innermost containing face, isolated vertices are
   located by exact ray casting.  The unbounded outer face is explicit.
4. **Incremental API** (`arrangement/arrangement.py`) —
   `add_segments` / `remove_segments` rebuild the topology
   transactionally (failed input raises and leaves the old topology
   untouched) while reusing ids: vertices are keyed by exact
   coordinates, edges by endpoint pair, faces by boundary signature, so
   elements unaffected by a change keep their ids.

## Verification

`Arrangement.verify()` independently checks:

- every original segment is exactly covered by atomic edges whose
  source set contains it (point segments must be vertices);
- half-edges are paired (each edge contributes exactly one half-edge
  per direction);
- every face boundary cycle is a closed walk along real edges;
- the Euler relation `V - E + F == 1 + C` (C = connected components).

## Library usage

```python
from arrangement import Arrangement

arr = Arrangement([[(0, 0), (4, 0)], [(4, 0), (4, 4)],
                   [(4, 4), (0, 4)], [(0, 4), (0, 0)]])
ids = arr.add_segments([[(0, 0), (4, 4)]])
arr.remove_segments(ids)
arr.verify()
arr.vertices(); arr.edges(); arr.faces(); arr.stats()
data = arr.to_dict()                 # JSON-safe
arr2 = Arrangement.from_dict(data)   # ids preserved
```

Coordinates may be ints, `Fraction`s, or exact strings like `"3/2"`.
Floats are rejected.

## JSON CLI

```
python3.11 -m arrangement.cli [commands.json]   # default: stdin
```

Commands: `build`, `add`, `remove`, `verify`, `dump`, `stats`,
`save`, `load`.  Example:

```json
{"commands": [
  {"op": "build", "segments": [[[0,0],[4,0]], [[0,1],[4,1]], [[2,0],[2,1]]]},
  {"op": "add", "segments": [[[0,0],[4,4]]]},
  {"op": "verify"},
  {"op": "dump"},
  {"op": "save", "path": "arr.json"}
]}
```

Output is one JSON result object per command; exit status is 0 iff all
commands succeeded (failures are reported and do not corrupt the
arrangement).

## Tests

```
python3.11 -m unittest discover -s tests -v
```

42 tests, all passing (last run: `Ran 42 tests in 5.6s — OK`):

- exact predicates (orientation, angular comparator, line keys,
  rational intersections);
- atomic decomposition (overlap chains, duplicates, verticals,
  zero-length points);
- sweep vs. brute-force pairwise reference on 60 seeded random inputs,
  plus T-junctions, multi-segment points, verticals, shared endpoints;
- arrangement behaviours: T-junctions, cross multi-point, overlap
  chains, nested closed loops (faces with holes), deleting a
  face-splitting edge, zero-length point segments (isolated and
  on-edge), exact rational vertices;
- incrementality: id stability of unchanged edges across add/remove,
  incremental-vs-full-rebuild equivalence, atomic failure handling;
- save/restore roundtrip preserving topology and ids;
- CLI end-to-end via subprocess.
