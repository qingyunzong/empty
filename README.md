# sensor-windows

Event-time sliding-window aggregation over out-of-order sensor samples.
Node.js 22, standard library only, tests via `node:test`.

## Model

- Input events (JSONL): `UPSERT`, `RETRACT`, `WATERMARK`.
  - `{"type":"UPSERT","sensorId":"s1","sampleId":"a","ts":0,"temp":20.5,"version":1}` (`version` optional)
  - `{"type":"RETRACT","sensorId":"s1","sampleId":"a"}`
  - `{"type":"WATERMARK","sensorId":"s1","ts":660000}`
- Windows: 10 min wide, 2 min slide — each sample belongs to exactly 5 overlapping panes.
- Per pane: median of valid temperatures (even counts average the two middle
  values), MAD, and outliers. A value is an outlier when its distance from the
  pane median is `> 3 * MAD` or `>= 5`.
- A pane finalizes once the watermark reaches `paneEnd + 1 min`.
- Before finalization, corrections and retracts incrementally recompute every
  overlapping pane and emit `ADD` / `WITHDRAW` / `CORRECTION` sequences;
  finalization emits `FINAL`.
- Rejections (stderr JSON, processing continues):
  - `BUDGET_EXCEEDED` — more than 8 version updates per sensorId
  - `LATE` — modification touching an already-finalized pane
  - `UNKNOWN_RETRACT` — retract of an unknown sample
- Fatal input (bad JSON, missing fields, unknown event type, unreadable file)
  exits with code 2.

## Output

JSONL on stdout, one record per emission:

```json
{"op":"ADD","sensorId":"s1","paneStart":0,"median":20.5,"mad":1,"outlierIds":["a"],"certificate":"<sha256>"}
```

`certificate` is the SHA-256 of the canonical `{sensorId, paneStart, median,
mad, outlierIds}` payload.

## Usage

```sh
node src/cli.js windows --in samples.jsonl
node --test
```

## Layout

- `src/windows.js` — windowing engine (library)
- `src/cli.js` — CLI entry point
- `test/windows.test.js` — acceptance + randomized tests
- `test/reference.js` — independent brute-force reference (shares no code with `src/`)
