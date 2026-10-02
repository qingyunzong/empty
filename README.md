# dispatch

Offline dispatch scheduler for a packaging/test house: assigns carriers to
test-tool windows under hard capacity budgets, with event-time processing and
late metrology re-prioritization. Node.js 22, standard library only.

## CLI

```
dispatch solve --in <dir> --out <dir> [--lag-ms <ms>]
```

Reads every `*.jsonl` file in `--in` (sorted by file name, then line order —
this order is the arrival order), processes events, and writes:

- `plan.json` — final optimal plan(s): objective, all tied optimal solutions,
  undispatched carriers, pending metros, watermark, stats
- `budget.json` — per tool window: `cap`, `used`, `remaining` (never negative),
  assigned carriers
- `rework.jsonl` — one JSON object per re-plan: reason, trigger event,
  objective before/after, carrier migrations
- `late.log` — events whose `eventTs` fell behind the watermark on arrival

Exit codes: `0` ok, `1` data error (e.g. `CAP_INVALID`), `2` usage error.

## Input events (one JSON object per line)

```json
{"type":"carrier","eventTs":0,"carrier":"C1","lot":"L1","qty":1,"op":"A","due":0}
{"type":"tool","eventTs":0,"tool":"T1","cap":2,"windowStart":0,"windowEnd":3600000,"op":"A"}
{"type":"metro","eventTs":0,"lot":"L1","score":10,"op":"A"}
{"type":"retract","eventTs":0,"kind":"tool","id":"T1"}
```

- Timestamps are epoch milliseconds (ISO-8601 strings also accepted).
  `due` on carriers is optional and defaults to `eventTs`.
- `carrier`/`tool` events upsert by `carrier`/`tool` id; a `retract` removes
  the carrier, the tool's window, or the metro score for a lot.
- `cap < 0` aborts the run with `CAP_INVALID`.

## Semantics

- **Watermark** = max event time seen so far minus 5 minutes (`--lag-ms`
  overrides). An event arriving with `eventTs` behind the watermark is *late*:
  it is logged to `late.log` and still applied.
- **Interval join**: a carrier is eligible for a tool window when the `op`
  matches and `windowEnd >= carrier.eventTs` (the carrier is ready before the
  window closes).
- **Hard budget**: assigning a carrier consumes `qty` of the window's `cap`;
  remaining capacity may never go negative. The committed plan is always the
  provably optimal feasible plan for the current state — any event (late
  metro, retraction, upsert) that would change it triggers an exact re-solve,
  recorded in `rework.jsonl`. Retracting a tool window cascade-migrates its
  carriers to other windows.
- **Objective**: lexicographic — maximize total metrology score of dispatched
  carriers, then dispatched count. Carriers of a lot without a metro score
  count as 0. A metro for an unknown lot is *pending* (listed in
  `plan.json`), never an error, and applies once such a carrier arrives.
- **Ties**: all optimal solutions are enumerated (up to 5000, flagged
  `truncated` beyond that). Assignments are ordered by `due`, `lot`,
  `carrier`; the solution list itself is deterministically sorted.

## Library

```js
import { Engine, solveAll, parseEvent } from './src/index.js';
```

## Tests

```
node --test
```

See `RESULTS.md` for the recorded run.
