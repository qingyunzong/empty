# sensor-window-aggregator

Event-time sliding-window aggregation for out-of-order sensor streams.
Node.js 22, standard library only, tested with `node:test`.

## Semantics

- **Windows**: 10-minute panes sliding every 2 minutes, aligned to the epoch.
  Every sample therefore belongs to exactly 5 overlapping panes.
- **Events** (one JSON object per line):
  - `{"type":"UPSERT","sensorId":"s1","sampleId":"a","ts":1700000000000,"temp":20.1}`
    inserts or corrects a sample (corrections may change `ts` and/or `temp`).
  - `{"type":"RETRACT","sensorId":"s1","sampleId":"a"}` removes a sample.
  - `{"type":"WATERMARK","ts":1700001000000}` advances the global watermark;
    an optional `sensorId` scopes it to one sensor.
- **Finalization**: a pane finalizes once the effective watermark reaches
  `paneEnd + 1 minute`. Until then, corrections and retracts of a sample are
  recomputed incrementally in exactly the panes overlapping that sample, and
  every change is emitted as an `ADD` / `WITHDRAW` / `CORRECTION` sequence.
  Finalized panes emit a `FINAL` record and are frozen.
- **Median**: middle value of the sorted temperatures; on a tie (even count)
  the two middle values are averaged. MAD is the median absolute deviation
  from the median, with the same tie rule.
- **Outliers**: a value is an outlier when its distance from the pane median
  exceeds `3 * MAD` **or** is `>= 5`.
- **Version budget**: each `(sensorId, sampleId)` accepts at most 8 versions;
  a 9th upsert is rejected with `BUDGET_EXCEEDED`.
- **Rejections** (reported, stream continues):
  - `BUDGET_EXCEEDED` — version budget exhausted.
  - `LATE` — upsert/retract touching an already finalized pane.
  - `UNKNOWN_RETRACT` — retract of a sample that was never seen.

## CLI

```sh
node src/cli.js windows --in examples/samples.jsonl
```

Stdout is JSONL, one record per pane change:

```json
{"op":"ADD","sensorId":"s1","paneStart":1699999800000,"median":20.1,"mad":0,"outlierIds":[],"certificate":"..."}
{"op":"WITHDRAW","sensorId":"s1","paneStart":1699999800000,"median":20.1,"mad":0,"outlierIds":[],"certificate":"..."}
{"op":"CORRECTION","sensorId":"s1","paneStart":1699999800000,"median":20.25,"mad":0.15,"outlierIds":[],"certificate":"..."}
{"op":"FINAL","sensorId":"s1","paneStart":1699999800000,"median":20.25,"mad":0.15,"outlierIds":[],"certificate":"..."}
```

Every result record carries `sensorId`, `paneStart`, `median`, `mad`,
`outlierIds` and a `certificate` (SHA-256 over the canonical pane contents).
Rejections are written to stderr as JSON lines tagged with the input line
number. Fatal input problems (`INVALID_JSON`, `INVALID_EVENT`,
`INPUT_UNREADABLE`, bad usage) also go to stderr as JSON and exit with code 2.

## Library

```js
import { WindowEngine } from './src/engine.js';
const engine = new WindowEngine();
const { outputs, errors } = engine.ingest(event);
```

## Tests

```sh
node --test
```

`test/engine.test.js` covers the acceptance scenarios (5 overlapping panes
updated by an out-of-order sample, tied median after retracting an outlier,
budget and late rejections) and cross-checks randomized streams against
`reference/reference.js`, an independent brute-force implementation that
shares no code with `src/`. `test/cli.test.js` drives the CLI end to end.
