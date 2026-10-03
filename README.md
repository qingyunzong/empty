# cold-recall

Cold-chain recall analysis: determines which shipment lots were exposed to
unexplained temperature excursions and computes the **minimum recall set**.
Node.js 22, standard library only, tests via `node:test`.

## Usage

```sh
node bin/cold.js recall --in <dir> --out <dir> \
  [--min-c N] [--max-c N] [--short-window-ms N] [--watermark-lag-ms N]
```

`--in` is a directory of `*.jsonl` event files (read in sorted filename
order). `--out` receives `recall.json`, `evidence.jsonl`,
`unexplained.jsonl`, `late.log`.

Library API: `import { processEvents, analyze, runRecall } from 'cold-recall'`
(see `index.js`).

## Input events (one JSON object per line)

| kind     | fields                                                        |
|----------|---------------------------------------------------------------|
| `temp`   | `id, eventTs, zone, c, [sensor], [op]`                        |
| `door`   | `id, eventTs, zone, open, [op]`                               |
| `ship`   | `id, eventTs, lot, zone, start, end, [op]`                    |
| `repair` | `id, eventTs, sensor, ok, [op]`                               |
| `retract`| `eventTs, targetKind, id`                                     |

Timestamps are epoch milliseconds (ISO-8601 strings also accepted).
`op` defaults to `add`; `del`/`retract`/`remove` deletes the event with the
same `kind`+`id`. A `retract` event removes the live event identified by
`targetKind`+`id`.

## Semantics

- **Watermark** = max event time − 2 minutes (configurable). Excursion
  windows are clipped to the watermark; windows starting past it are pending
  and ignored. Events read with `eventTs` below the running watermark are
  logged to `late.log` but still processed.
- **Excursion window**: per zone, from the first out-of-range trusted
  reading (`c < minC` or `c > maxC`, defaults `-30..8`) to the first
  in-range trusted reading; an unclosed window ends at the watermark.
- **Sensor trust**: `repair(ok=false)` marks a sensor faulty from that time,
  `repair(ok=true)` healthy. Readings taken while faulty are dropped.
  Retracting a repair re-evaluates trust, which can extend excursion
  windows and expand the recall set. `temp.sensor` defaults to the zone.
- **Door explanation**: an excursion whose duration ≤ `shortWindowMs`
  (default 5 min) and that overlaps a door-open interval in the same zone
  is *explained* and needs no recall.
- **Exposure**: a lot is exposed to an unexplained window iff its ship
  window strictly overlaps it (`start < wEnd && end > wStart`); touching
  endpoints do not count.
- **Recall set**: the minimum set of lots covering every unexplained
  window (each recalled lot covers the windows it is exposed to). All
  minimum solutions are enumerated, each sorted lexicographically, listed
  in lexicographic order. No excursions → `solutions: [[]]` (not an error).
  An uncoverable window yields `minimumSize: null, solutions: []`.
- **TEMP_RANGE**: a `temp` reading outside the physical range
  `[-100, 100]` °C aborts with exit code 1 and a `TEMP_RANGE` error.

## Outputs

- `recall.json` — watermark, thresholds, `minimumSize`, all minimum
  `solutions`, `exposedLots`, unexplained window count.
- `evidence.jsonl` — `explained` (door-open) and `exposure` records.
  Retracted ships disappear from both recall and evidence.
- `unexplained.jsonl` — one record per unexplained window with exposed lots.
- `late.log` — late events (eventTs below the running watermark) and
  no-op retractions.

## Tests

```sh
node --test
```
