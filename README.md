# seq-batch-join

Streaming join of sequencing READ_METRIC events to BATCH intervals, with
watermark-based freezing, batch corrections and retractions. Node.js 22,
standard library only, tested with `node:test`.

## CLI

```sh
node src/cli.js batches --in events.jsonl   # use `--in -` or omit for stdin
```

Emits one JSON action per line, then a final `CERTIFICATE` line containing all
member ids, batch versions (full interval history) and counts.

## Events (JSONL input)

```json
{"type":"BATCH","batchId":"b1","op":"UPSERT","start":100,"end":200,"version":1}
{"type":"BATCH","batchId":"b1","op":"RETRACT"}
{"type":"READ_METRIC","metricId":"m1","batchId":"b1","ts":150,"yield":900,"quality":0.9}
{"type":"WATERMARK","ts":500}
```

## Semantics

- A metric matches its `batchId` when `ts` is inside the current half-open
  interval `[start, end)`.
- Batch UPSERT versions must increase per `batchId`; every version's interval
  is kept in history. A version `<=` current is rejected (`STALE_VERSION`).
- Interval changes migrate metrics between MATCHED and UNMATCHED, emitting
  `ADD` / `WITHDRAW` actions; a new metric starts as `ADD` or `UNMATCHED`.
- A metric freezes once the common `WATERMARK` exceeds `ts + 30s`. Corrections
  or retractions that would migrate a frozen metric are rejected per metric
  with a `LATE` error; unfrozen metrics still migrate.
- Validation errors: `INVALID_RANGE` (`end <= start`), `INVALID_QUALITY`
  (`quality` outside `[0, 1]`), `UNKNOWN_RETRACT` (retracting an unknown batch).

## Library

```js
import { createEngine } from './src/engine.js';
const engine = createEngine();
const actions = engine.process(event);   // -> array of action objects
const cert = engine.certificate();       // -> final certificate object
```

`src/reference.js` is a brute-force reference (per metric, rescan all applied
batch versions at every watermark stage) used by the differential test.

## Tests

```sh
node --test
```
