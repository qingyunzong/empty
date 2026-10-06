# path-fill-geometry

A small TypeScript geometry library that parses a limited SVG-style path
command set — move (`M`/`m`), line (`L`/`l`), close (`Z`/`z`) — and hit
tests integer query points against the filled region using the **even-odd**
or **non-zero winding** rule. Boundary points count as inside, and open
subpaths are closed implicitly when filled.

## Usage

```ts
import { hitTestPath } from 'path-fill-geometry';

const result = hitTestPath(
  'M0 0 L20 0 L20 20 L0 20 Z M5 5 L15 5 L15 15 L5 15 Z',
  10, 10,
  { rule: 'nonzero' },
);
```

`HitTestResult` reports:

- `inside` / `onBoundary` — final verdict; boundary counts as inside.
- `hits` — indices of the rings (subpaths) that individually contain the
  query point under the requested rule.
- `rings` — per-ring direction evidence: `signedArea2`, `direction`
  (`ccw` / `cw` / `degenerate`), `winding` and `crossings` contributions at
  the query point, `closed` vs `implicitlyClosed`, and per-rule containment.
- `selfIntersections` — edge-by-edge reference self-intersection findings
  per ring (`cross` / `touch` / `overlap` with edge indices), computed with
  an O(n²) scan intended for short paths. Rings with more edges than
  `selfIntersectionEdgeLimit` (default 128) are skipped, in which case
  `selfIntersectionChecked` is `false`.

Lower-level pieces are exported too: `parsePath`, `ringEdges`,
`ringContainment`, `signedArea2`, `findSelfIntersections`,
`segmentsIntersect`, `onSegment`.

## Semantics

- **Implicit close** — every subpath is filled as if a closing edge from
  its last vertex back to its first existed, whether or not `Z` was used.
- **Boundary inside** — a query point exactly on an edge (endpoints
  included) is inside under both rules, detected exactly via integer cross
  products.
- **Rules** — `nonzero`: inside when the summed winding number is non-zero;
  `evenodd`: inside when the total ray-crossing count is odd.
- **Numbers** — path data accepts signs, decimals and exponents; query
  points are arbitrary numbers, with exact sign tests for safe-integer
  inputs.

## Scripts

- `npm test` — type-check, compile to `dist/`, and run the test suite with
  the Node built-in test runner.
- `npm run build` — compile only.

Note: `test/node-shims.d.ts` provides minimal offline typings for
`node:test` / `node:assert` because the sandbox has no registry access;
drop in `@types/node` when available.
