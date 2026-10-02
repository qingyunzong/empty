# cnc-feed-planner

Offline, single-machine CNC feed (进给) planning library and CLI for Node.js 22.
No dependencies; all arithmetic is exact rational arithmetic on BigInt.

## Model

- Each segment defines a velocity polynomial `v(t) = sum c_i t^i` with rational
  coefficients, degree `<= 5`, on a rational time window `[a, b]` (`a < b`).
- Position increments are computed with the exact antiderivative
  (degree `<= 4` is cross-checked against a direct monomial sum).
- Each segment is cut into fixed rational time slots of width `slot`
  (last slot may be shorter). Per slot, the exact increment is quantized to a
  multiple of `10^-k`, rounding half up (`floor(x + 1/2)`).
- Guarantees enforced at commit time (otherwise `E_TOLERANCE`, no trajectory):
  - per-segment cumulative absolute error `<= segmentTolerance`
  - total cumulative absolute error `<= totalTolerance`
- Non-negativity of `v` on `[a, b]` is decided exactly (Sturm sequences over
  the rationals, endpoint root peeling, root isolation + sign sampling).
  A negative velocity, `a >= b`, degree `> 5`, or invalid quantization
  parameters roll back the whole multi-segment edit transaction.
- Committed edits support `undo` / `redo`; certificates are restored exactly.

## Library

```js
import { Planner } from './src/index.js';

const planner = new Planner();
const cert = planner.commit({
  segments: [{ coeffs: ['1/2', '1/4'], a: '0', b: '2' }],
  params: { k: 3, slot: '1/2', segmentTolerance: '1/100', totalTolerance: '1/10' },
});
planner.undo();
planner.redo();
```

The certificate reports, per segment: exact integral, per-slot exact and
quantized increments, per-slot error bound (`10^-k / 2`), cumulative absolute
error, cumulative error bound, plus trajectory-wide totals.

## CLI

Reads one JSON document from stdin, writes a single JSON line to stdout.
Exit code `0` when every op succeeds, `1` otherwise.

```sh
echo '{"ops":[{"op":"commit","segments":[{"coeffs":["1/2"],"a":"0","b":"1"}],
  "params":{"k":0,"slot":"1","segmentTolerance":"1/2","totalTolerance":"1/2"}}]}' \
  | node src/cli.js
```

Ops: `commit` (with `segments` + `params`), `undo`, `redo`, `certificate`.
A bare op object (without `ops`) is treated as a single-op request.
Rationals are JSON strings (`"3/4"`, `"-2"`, `"1.25"`) or numbers.

Error codes: `E_TOLERANCE`, `E_NEGATIVE_VELOCITY`, `E_INVALID_SEGMENT`,
`E_INVALID_QUANTIZATION`, `E_INVALID_TOLERANCE`, `E_INVALID_INPUT`,
`E_UNDO_EMPTY`, `E_REDO_EMPTY`, `E_INTERNAL`.

## Tests

```sh
node --test
```
