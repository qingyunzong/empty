# boiler-interlock-replay

Offline replay verifier for steam-boiler interlock trips. Proves (or disproves)
that a shutdown was caused by a sustained pressure+temperature combination
rather than sensor jitter. Node.js 22, standard library only, `node:test`.

## Model

- Input: JSONL files (`*.jsonl`, sorted by name) in a directory. One event per line:
  - `{"type":"sensor","eventTs":N,"tag":"PT-101","value":N,"unit":"kPa","seq":N,"id":"...","op":"upsert"}`
  - `{"type":"trip","eventTs":N,"channel":"CH1","state":"ON","id":"..."}`
  - `{"type":"retract","eventTs":N,"kind":"sensor|trip","id":"..."}`
- Sliding window over event time (default 5000 ms): the condition
  `pressure > limit AND temp > limit` is evaluated on the joined streams
  (latest sample of each tag inside the window).
- ARM: the combined condition must hold continuously for `holdMs`
  (default 3000 ms). TRIP: a trip channel is ON while ARM is active.
- Watermark = maxEventTs - 1000 ms. Samples at or above the watermark are on
  time; samples below it are late: they are inserted into history, derived
  state is recomputed, and any previously emitted ARM/TRIP that no longer
  holds is revoked with a `COMPENSATE` record in `states.jsonl`.
- Retracting a sample restores alarms it had suppressed (same recompute path).
- Crash recovery: after each event-time batch, `snapshot.json` is written
  atomically (tmp + rename). On restart, replay resumes from the last
  committed batch; `states.jsonl`/`late.log` are truncated to the committed
  byte offsets. Duplicate events are idempotent by `id`.

## CLI

```
interlock replay --in <dir> --out <dir> [--pressure-limit N] [--temp-limit N] \
  [--window-ms N] [--hold-ms N] [--watermark-lag-ms N] [--batch-delay-ms N]
```

Outputs in `--out`:
- `states.jsonl` — append-only effect log: ARM/DISARM/TRIP/TRIP_CLEAR plus
  COMPENSATE reverse-compensation records.
- `proof.json` — deterministic proof: final transitions, ARM intervals with
  sustaining samples as evidence, per-trip verdict
  (`COMBINATION_CONFIRMED`), summary.
- `late.log` — late samples, duplicate ids, retractions (JSONL).
- `snapshot.json` — recovery point (internal).

Exit codes: `0` ok, `1` generic error, `2` `UNIT_MISSING` (sensor event
without `unit`).

## Library

```js
import { InterlockEngine, computeTransitions } from "./src/engine.js";
import { replay } from "./src/replay.js";
```

## Tests

```
node --test
```

See `RESULTS.md` for the latest recorded run.
