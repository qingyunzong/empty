# sample-qc-joiner

Event-time tumbling-window join of scientific-instrument event streams
(`SAMPLE_ACQUIRED` and `QC_RESULT`) on `sampleId`, with a durable,
append-only state log and crash recovery. Node.js 22, standard library only.

## Semantics

- Windows are 5-minute tumbling windows over event time
  (`windowStart = floor(eventTime / 300000) * 300000`).
- `JOINED` is published as soon as both sides of a `sampleId` exist in the
  same window (arrival order does not matter).
- `RETRACT` of one side before the window closes cascades: the join is
  withdrawn (`WITHDRAW`) and the remaining side is re-judged, emitting
  `EXPIRED_UNJOINED` when the watermark closes the window.
- A `WATERMARK` closes every window whose end is `<=` the watermark time.
  Windows are closed by brute-force matching both side sets per window;
  any side missing its counterpart yields `EXPIRED_UNJOINED`.
- Events (upsert or retract) arriving for an already-closed window are
  reported as `LATE`.
- `RETRACT` of an event that does not exist is an `UNKNOWN_RETRACT` error.

## Input (JSON Lines on stdin, or `--input <file>`)

```json
{"type":"EVENT","event":"SAMPLE_ACQUIRED","op":"UPSERT","sampleId":"S1","eventTime":1700000001000}
{"type":"EVENT","event":"QC_RESULT","op":"UPSERT","sampleId":"S1","eventTime":1700000002000}
{"type":"EVENT","event":"QC_RESULT","op":"RETRACT","sampleId":"S1","eventTime":1700000002000}
{"type":"WATERMARK","time":1700000100000}
```

## CLI

```
node src/cli.js --state state.log [--recover] [--crashAfter N] [--input file]
```

- `--state <path>`: durable state log. Every valid input record is persisted
  with `appendFileSync` before it is processed; emitted outputs and a commit
  marker follow each record.
- `--crashAfter N`: exit with code 101 right after the Nth valid record has
  been persisted, before its results are emitted (crash simulation).
- `--recover`: replay the state log, re-emit only the uncommitted tail, then
  continue with stdin. Records already present in the log are skipped when
  they reappear on the input, so pre-crash committed results are neither
  duplicated nor lost; the combined output equals a crash-free run.

## Errors

Errors are written to stderr as a single JSON line and exit with code 2:

- `MALFORMED` - invalid JSON line or record/argument failing validation
- `UNKNOWN_RETRACT` - retract of a non-existent event
- `DURABLE_STATE_CORRUPT` - state log is unreadable, has broken
  sequence/structure, or contradicts deterministic replay

Crash simulation exits with code 101. Successful runs exit with code 0.

## Library

```js
const { Joiner, StateLog, replayLog, validateRecord } = require('./index');
```

`Joiner#process(record)` is pure in-memory and returns the output records
for one input record, which makes replay fully deterministic.

## Tests

```
node --test
```

Covers out-of-order joins, retract cascades, late events, watermark expiry,
crash-after-N recovery equivalence against a clean run, and all error codes.
See `test-results.txt` for a recorded run.
