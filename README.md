# sensor-calibration-chain

Incremental maintenance of sensor observation calibration chains.
Node.js 22, standard library only (`node:test`, `node:crypto`), fully offline.

## Model

- Each sensor owns coefficients `{ raw, offset, scale }` and at most one
  calibration base. Calibrated values apply `y = x * scale + offset` along
  the reference chain, starting from the chain root's raw reading.
- Adding a second base to a sensor fails with `E_TOPO`; any edge that would
  close a cycle fails with `E_CYCLE`.
- Coefficient corrections invalidate only the affected transitive closure;
  untouched sensors keep their cached values (see `recomputeCount`).
- A sensor whose base is missing (or whose upstream is blocked) is `blocked`
  with `confidence: 0` and `value: null`; otherwise `confidence: 1`.
- `undo()` / `redo()` restore full states; any new mutation after an undo
  clears the redo stack.
- Certificates are deterministic: `coefficientsHash` and `topologyHash` are
  SHA-256 over canonical (sorted) JSON, plus a deterministic topological
  `ordering` (Kahn, lexicographic tie-break).

## Library

```js
import { CalibrationChain } from './src/chain.js';
const chain = new CalibrationChain();
chain.addSensor('a', { raw: 1, offset: 1, scale: 2 });
chain.addSensor('b', { raw: 0, offset: 0, scale: 3 });
chain.addCalibration('b', 'a');
chain.getResult('b');   // { ok: true, result: { id, version, value, confidence, blocked } }
chain.snapshot();       // { version, results, certificate }
```

Mutations return `{ ok: true }` or `{ ok: false, error: { code, message } }`
with codes `E_TOPO`, `E_CYCLE`, `E_UNKNOWN_SENSOR`, `E_SENSOR_EXISTS`,
`E_NO_BASE`, `E_INVALID`, `E_UNDO_EMPTY`, `E_REDO_EMPTY`.

## CLI

```sh
node src/cli.js < req.json
```

`req.json` is `{ "ops": [...] }` (or a bare op array / single op). Supported
ops: `addSensor`, `removeSensor`, `setCoefficients`, `addCalibration`,
`removeCalibration`, `undo`, `redo`, `getResult`, `snapshot`, `certificate`.
Output is `{ ok, results, snapshot }` with one result per op.

## Tests

```sh
node --test > test-results.txt 2>&1
```

- `test/chain.test.js` — unit tests: chains, `E_TOPO`/`E_CYCLE`, blocked
  propagation, base replacement, incremental recompute counts, undo/redo.
- `test/differential.test.js` — randomized differential test (<= 8 sensors,
  40 seeds x 120 steps) comparing values, blocked sets, and certificates
  against the full-enumeration reference in `src/reference.js`.
- `test/cli.test.js` — CLI request/response tests (in-process; this
  environment disallows child processes, the real entry is verified via
  `node src/cli.js < req.json`).
