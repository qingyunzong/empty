# sequencing-batch-join

Joins a stream of `READ_METRIC` events to versioned `BATCH` intervals, driven by a
common `WATERMARK`. Node.js 22, standard library only, tests via `node:test`.

## Run

```sh
node src/cli.js batches --in events.jsonl   # emits JSONL actions + final CERTIFICATE
node --test                                 # runs the full suite
```

## Event schema (JSONL, one per line)

```json
{"type":"READ_METRIC","metricId":"m1","batchId":"b1","ts":42,"yield":128.5,"quality":0.93}
{"type":"BATCH","op":"UPSERT","batchId":"b1","start":0,"end":100,"version":1}
{"type":"BATCH","op":"RETRACT","batchId":"b1","version":2}
{"type":"WATERMARK","ts":200}
```

## Semantics

- A metric joins the batch named by its `batchId` when `ts ∈ [start, end)` of the
  batch's current version. Metrics may arrive before their batch (emitted as
  `ADD`/`UNMATCHED`) and flip to `MATCHED` when the batch later appears.
- Every `batchId` keeps its full interval history (`versions` in the certificate);
  the greatest version is current. A new version must be strictly greater, otherwise
  `STALE_VERSION`. An `UPSERT` after a `RETRACT` revives the batch.
- Corrections (upsert/retract) re-evaluate the batch's metrics: a metric entering the
  interval emits `ADD`/`MATCHED`, leaving it emits `WITHDRAW` (cascading per metric).
- A metric freezes once `watermark >= ts + 30s`. A correction that would change a
  frozen metric is rejected and reported as `LATE`; the metric keeps its status.
- Validation: `end <= start` → `INVALID_RANGE`; `quality` outside `[0,1]` →
  `INVALID_QUALITY`; retracting an unknown batch → `UNKNOWN_RETRACT`.
- The final `CERTIFICATE` lists every batch (id, current version, all versions,
  retracted flag, matched count), every metric (id, batch, status, frozen), and totals.

## Layout

- `src/engine.js` — incremental engine (`createEngine`), the single source of truth.
- `src/reference.js` — brute-force reference: recomputes every metric of the touched
  batch from scratch per event and records a stage snapshot after each event, so tests
  can enumerate results at every watermark stage.
- `src/cli.js` — JSONL in → JSONL actions + certificate out.
- `test/` — engine units, the three acceptance scenarios, a seeded differential test
  (engine vs reference, action streams and per-stage snapshots), and CLI tests.

## Assumptions

- A metric targets exactly the batch named by `batchId`; the interval decides
  membership (no cross-batch matching).
- Freeze boundary is inclusive: `watermark >= ts + 30`.
- `RETRACT` carries a `version` that must also be newer than the current one.
