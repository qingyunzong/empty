# safe-zone

Robot cell safety zone: convex polygon with exact rational arithmetic (BigInt fractions).
No floats, no square roots — all distances are exact squared gaps as `p/q` strings.

## Library

```js
import { SafeZone } from './src/zone.js';

const zone = new SafeZone([{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}]);
zone.addVertex(2, {x:'7/2', y:2});     // transactional; throws ZoneError on invalid
zone.updateVertex(0, {x:'1/2', y:0});  // rolls back entirely if non-convex/duplicate
zone.removeVertex(3);
zone.undo(); zone.redo();

const r = zone.query({p:{x:1,y:1}, q:{x:3,y:1}});
// r.classification: 'inside' | 'touching' | 'outside'
// r.minGapSquared: exact fraction string, e.g. '1/2'
// r.nearestEdge + r.certificate: edge params, projection points, per-edge gaps
```

Rules:
- Polygon must be convex; collinear edges allowed; vertices are rationals
  (integer number, `"p/q"` string, or `{num, den}`).
- `addVertex` / `updateVertex` / `removeVertex` are transactions: any violation
  (non-convex, duplicate point, self-intersection, <3 vertices) rolls the whole
  edit back; undo/redo history is untouched by failed transactions.
- Endpoint-only contact with the boundary is `touching`, not `outside`;
  a segment on the boundary has gap `0`; zero-length segments work as points.
- Errors: `E_EMPTY` (<3 vertices / query before init), `E_GEOMETRY`
  (non-convex, duplicate, self-intersecting), `E_INPUT` (bad JSON/rational),
  `E_INDEX` (vertex index out of range).

## CLI

Reads a JSON session from stdin (single command, array, or `{commands:[...]}`),
prints `{results:[...]}` to stdout:

```sh
echo '{"commands":[{"op":"init","vertices":[{"x":0,"y":0},{"x":6,"y":0},{"x":0,"y":6}]},
  {"op":"query","segment":{"p":{"x":2,"y":3},"q":{"x":2,"y":3}}}]}' | node src/cli.js
```

Ops: `init`, `addVertex`, `updateVertex`, `removeVertex`, `undo`, `redo`, `state`, `query`.

## Tests

```sh
node --test
```
