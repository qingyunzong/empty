# safezone

Robot-cell safety zone library and CLI for Node.js 22 (offline, zero
dependencies). All geometry is computed with **exact rational arithmetic**
(BigInt fractions) — no floats, no square roots anywhere.

## Model

- Polygon vertices and segment endpoints are rational points.
- The polygon must be **convex**; collinear consecutive edges are allowed.
- Incremental edits (`addVertex` / `updateVertex` / `removeVertex`) are
  **transactions**: if the resulting polygon would be non-convex,
  self-intersecting, contain duplicate points, or drop below 3 vertices, the
  whole transaction rolls back and the undo/redo history is left untouched.
- Every successful commit is a new version; `undo()` / `redo()` move between
  versions. A new commit clears the redo stack.

## Error codes

| Code         | Meaning                                                     |
|--------------|-------------------------------------------------------------|
| `E_GEOMETRY` | non-convex, self-intersecting, duplicate or degenerate input |
| `E_EMPTY`    | fewer than 3 vertices                                        |
| `E_PARSE`    | malformed JSON / coordinates / ops                           |
| `E_INDEX`    | vertex index out of range                                    |
| `E_UNDO`     | nothing to undo/redo                                         |

## Segment analysis

`analyzeSegment(a, b)` classifies the segment:

- `inside`   — strictly inside the zone
- `touching` — inside the closed zone and touching the boundary
               (endpoint-only contact counts as touching, **not** as crossing out)
- `outside`  — pokes out of the zone (crosses the boundary or lies outside)

and returns:

- `gapSquared` — minimum squared gap to **all** edges, as an exact fraction
  (`"p/q"` string). Zero iff the segment touches/crosses the boundary or lies
  on it.
- `nearestEdge` — index and endpoints of the closest polygon edge.
- `pointOnSegment` / `pointOnEdge` — the two projection points realizing the
  minimum gap (exact rational coordinates).
- `tSegment` / `tEdge` — projection parameters in `[0,1]` as fractions.
- `certificate` — everything needed to re-verify the result independently:
  polygon orientation, per-endpoint classification with per-edge orientation
  signs, per-edge squared gaps with both projection points and parameters,
  and boolean consistency checks.

A degenerate zero-length segment (a point) is handled correctly: it reports
its inside/touching/outside status and the squared distance to the boundary.

## Library usage

```js
import { SafeZone } from './src/safezone.js';

const zone = new SafeZone([[0, 0], [4, 0], [4, 4], [0, 4]]);
zone.updateVertex(2, [3, 3]);            // { ok: true, ... } or { ok: false, error }
zone.undo(); zone.redo();
const r = zone.analyzeSegment(['1/3', '1/3'], [2, 1]);
// r.status, r.gapSquared (Fraction), r.nearestEdge, r.certificate, ...
```

Coordinates are accepted as integers, `"p/q"` strings, `[num, den]` pairs or
`{ num, den }` objects. `Fraction` values are exact; `toString()` renders
`"p/q"`.

## CLI

Reads one JSON request from stdin, writes one JSON response to stdout.

```sh
echo '{"vertices":[[0,0],[4,0],[4,4],[0,4]],"segment":[[1,1],[3,1]]}' | node cli.js
```

Request:

```json
{
  "vertices": [[0,0],[4,0],[4,4],[0,4]],
  "ops": [
    { "op": "addVertex",    "point": [2,5], "index": 3 },
    { "op": "updateVertex", "index": 2, "point": [3,3] },
    { "op": "removeVertex", "index": 0 },
    { "op": "transact", "ops": [ ... ] },
    { "op": "undo" },
    { "op": "redo" }
  ],
  "segment": [[1,1],[3,1]]
}
```

`vertices`, `ops` and `segment` are all optional. The response contains the
final `vertices`, `version`, `canUndo`/`canRedo`, per-op results, and the
`analysis` object described above. Domain errors are reported in-band with
exit code 0; malformed JSON exits with code 1 and `E_PARSE`.

## Tests

```sh
node --test
```

See `TEST_RESULTS.md` for the recorded real run. The suite covers the
acceptance criteria:

1. `test/analyze.test.js` — for convex polygons with n = 3..6 (including
   collinear-edge and rational-coordinate cases) the reported `gapSquared`
   and every per-edge certificate entry are checked against an independent
   brute-force per-edge enumeration implemented in the test file.
2. `test/analyze.test.js` — a segment transitions from `inside` to
   `touching` across two adjacent committed versions (and back after undo).
3. `test/transactions.test.js` — an illegal vertex transaction rolls back
   completely and the undo/redo information is provably unchanged.
4. `test/analyze.test.js` — degenerate zero-length segments report correct
   inside / touching / outside status with exact gaps.
