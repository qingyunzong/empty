# int-polygon-editor

Integer-coordinate polygon vertex editing library. Every edit is validated
with **exact** arithmetic before it is published; invalid edits are rejected
atomically and previously published versions remain readable.

Pure TypeScript, Node.js built-in modules only (`node:test` for tests), no
runtime dependencies.

## Model

- A `Polygon` is one `outer` ring plus `holes` (ring 0 = outer, rings 1.. = holes).
- Rings are open vertex lists (last vertex connects back to the first).
- All coordinates must be integers.

## Rejection rules (touching counts as a conflict)

After any vertex move the whole polygon is re-validated by checking **every
pair of edges** with exact (`BigInt`) predicates:

- `self-intersection` / `self-touch` / `self-overlap` — non-adjacent edges of
  the same ring cross, touch, or collinearly overlap; adjacent edges may share
  only their common endpoint (fold-back overlap is rejected).
- `ring-crossing` / `ring-touch` / `ring-overlap` — any intersection at all
  between edges of different rings (outer vs hole, hole vs hole).
- `hole-outside-outer` — a hole ring is not strictly inside the outer ring
  (exact point-in-ring probe after edge disjointness is established).
- `hole-inside-hole` — a hole is nested inside another hole.
- `degenerate-ring` — fewer than 3 vertices, non-integer vertex, or
  zero-length edge.

Every conflict carries concrete edge evidence: `edge1`/`edge2` identify the
ring index, edge index, and both endpoints; touches include the exact `point`.

## Exactness

Orientation, segment intersection, and point-in-ring are computed in `BigInt`,
so results are exact for any safe-integer input. The test suite includes a
case where `float64` cancellation yields sign 0 (products of `2^55 − 2`
rounding to `2^55`) while the exact predicate returns the true sign −1 — a
razor-thin triangle of area 1 that naive arithmetic would call degenerate is
accepted, and its exact collapse onto an edge is rejected.

## API

```ts
import { PolygonStore } from './src/store.js';

const store = new PolygonStore();
store.create('p', { outer: [...], holes: [[...]] });   // -> { ok: true, version: 1 }

// Batch move: ALL moves are applied to a scratch copy, fully validated,
// and only then published. Any conflict rejects the whole batch.
const r = store.moveVertices('p', [
  { ring: 0, index: 1, to: { x: 24, y: 0 } },
  { ring: 1, index: 0, to: { x: 3, y: 3 } },
]);
// r = { ok: true, version: 2 } | { ok: false, conflicts: [...] }

store.get('p');        // latest version (deep copy)
store.get('p', 1);     // old versions remain readable
store.latestVersion('p');
```

## Test

```
npm test    # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

Requires `tsc` (TypeScript compiler) on PATH; no other dependencies.

## Recorded test results (2026-10-05, Node v22.22.1, TypeScript 7.0.2)

`npm test` — 3 files, 24 tests, all passing:

```
ok - orient is exact where float64 cancels to zero
ok - segmentRelation classifies cross / touch / overlap / none
ok - segmentRelation touch is exact at large coordinates
ok - pointInRing handles convex, concave and large coordinates
ok - valid polygon with a hole passes
ok - valid hole-less polygon passes
ok - self-intersection reports the exact crossing edges
ok - self-touch reports the touching point and edges
ok - non-adjacent collinear overlap is a self-overlap conflict
ok - adjacent fold-back overlap is rejected
ok - ring crossing between hole and outer reports both edges
ok - hole merely touching the outer ring is a conflict
ok - hole fully outside the outer ring is caught by containment
ok - hole nested inside another hole is a conflict
ok - degenerate rings are rejected with reasons
ok - create publishes version 1 and rejects invalid input
ok - batch move publishes a new version; old versions stay readable
ok - rejected batch is atomic: nothing is published
ok - move making the ring self-intersect gives edge evidence
ok - move pushing the hole outside the outer ring is rejected
ok - move making the hole touch the outer ring is rejected (touch = conflict)
ok - exactness: razor-thin valid triangle is accepted, exact collapse rejected
ok - invalid move targets and non-integer targets are rejected
ok - returned polygons are deep copies; history cannot be mutated

# tests 3 (files) / 24 (cases)
# pass 3 / 24
# fail 0
```
