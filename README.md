# cold-recall

Cold-chain recall analysis: determines the **minimal set of shipment lots** exposed to
unexplained temperature anomalies, with support for event retraction (sensor repairs,
shipments, door events). Node.js 22, standard library only, offline.

## Install / Run

```sh
node bin/cold.js recall --in <dir> --out <dir>
# or, after npm link / npm install -g:
cold recall --in <dir> --out <dir>
```

Options: `--max-c <celsius>` (anomaly threshold, default `-15`),
`--lateness-ms <ms>` (allowed lateness behind the watermark, default `120000`).

Tests: `node --test`

## Input

`--in` points to a directory of `*.jsonl` files (read in filename order; line order =
arrival order). One event per line:

```json
{"type":"temp","id":"t1","eventTs":1700000000000,"zone":"A","c":-10}
{"type":"door","id":"d1","eventTs":1700000030000,"zone":"A","open":true}
{"type":"ship","id":"s1","eventTs":1700000060000,"lot":"L1","zone":"A","start":1699999940000,"end":1700000120000}
{"type":"repair","id":"r1","eventTs":1700000180000,"sensor":"A","ok":true}
{"type":"retract","eventTs":1700000240000,"kind":"ship","id":"s1"}
```

- `eventTs` is epoch milliseconds. `id` is optional but required for retraction;
  re-adding the same `type`+`id` upserts.
- Retraction works two ways: a `retract` event (`kind` in `temp|door|ship|repair`),
  or `op:"retract"` on an event carrying the same `id`.

## Semantics

- **Anomaly windows**: per zone, consecutive readings with `c > maxC` (gap <= 15 min)
  form a window `[start, end)`; `end` is the first in-limit reading, or the last
  over-limit reading if the zone never recovers.
- **Watermark**: `max(eventTs) - 2 min`. Events arriving (in file order) with
  `eventTs` behind the watermark are dropped and logged to `late.log`.
- **Door explanation**: a window of <= 20 min with a `door open=true` event in the
  same zone during `[start - 5min, end]` is explained and causes no recall.
- **Repair**: a live `repair(ok=true)` for a sensor (= zone name) marks all readings
  at or before it as untrusted and dismisses them. Retracting the repair removes the
  trust boundary, so previously dismissed readings count again (recall may grow).
- **Exposure**: a lot is exposed iff its ship window overlaps an unexplained anomaly
  window with positive length; touching endpoints do **not** count.
- **Recall set**: the minimum set cover of exposed lots over all unexplained windows.
  All tied minimum solutions are enumerated (exact for <= 24 candidate lots, greedy
  fallback beyond) and listed in lexicographic lot order. With no anomalies the
  result is the empty set, not an error.
- **Validation**: `c` outside `[-273.15, 100]` fails with `TEMP_RANGE` (exit 1).

## Output (`--out` directory)

- `recall.json` — watermark, counts, `minimalSize`, `lots` (first solution),
  `solutions` (all tied minimum covers), uncoverable windows.
- `evidence.jsonl` — one record per (recalled lot, exposed window) pair.
- `unexplained.jsonl` — unexplained anomaly windows with their exposed lots.
- `late.log` — JSONL of events dropped for arriving behind the watermark.
