# demand-audit

Offline, single-machine auditor for 15-minute demand peaks. Replays a JSONL
event stream (meter / tariff / shed / retract), rebuilds corrected demand
windows after estimated meter readings are superseded by actuals, and proves
whether the executed load-shedding decision was cost-optimal.

Node.js 22, standard library only, tests via `node:test`.

## Usage

```sh
node bin/demand.js audit --in <dir> --out <dir> [--budget <kw>]
```

Reads every `*.jsonl` file in `--in` (lexicographic order) and writes:

- `windows.jsonl` — one row per 15-min window: `kwh`, `demandKw`, `shedKw`,
  `baselineKw` (demand + executed shed), joined `rate`/`tariff`, `estimated`
  and `final` flags, and the executed `sheds`.
- `settlement.json` — watermark, realized peak, optimal plan(s) vs. executed
  plan, and `executedIsOptimal`.
- `comp.jsonl` — compensation records for forbidden shed retractions.
- `late.log` — late events (event time below the watermark), malformed lines,
  and retracts of unknown ids.

Exit codes: `0` ok, `1` audit error (e.g. `METER_ROLLBACK`), `2` usage error.

## Event model

```json
{"type":"meter","id":"r1","eventTs":"...","meter":"M1","kwh":1030,"estimated":false}
{"type":"tariff","id":"t1","eventTs":"...","name":"peak","start":"...","end":"...","rate":12.5}
{"type":"shed","id":"s1","eventTs":"...","load":"HVAC-1","kw":50}
{"type":"retract","eventTs":"...","kind":"meter|tariff|shed","id":"r1"}
```

Timestamps accept ISO-8601 strings or epoch ms. `op:"retract"` on an event is
equivalent to a standalone `retract` of its own id. Events without `id` get a
generated `type#line` id.

## Semantics

- **Windows**: event times align to 15-min windows. A meter delta between
  consecutive cumulative readings is attributed to the window ending at (or
  containing) the later reading. Multiple meters sum into the same window.
- **Watermark**: `max(eventTs) - 1 minute`, tracked as events stream in.
  Events arriving below the watermark are logged to `late.log` but still
  applied. A window is `final` when its end is at or below the watermark.
- **Estimated readings**: a window is flagged `estimated` if any contributing
  reading was estimated. Replacing an estimate with an actual is
  `retract(meter, estimateId)` + a new `meter` event; window energy is
  recomputed incrementally from the surviving readings.
- **Tariff join**: a window takes the rate of the surviving tariff whose
  `[start, end]` covers the whole window; latest `eventTs` wins on overlap.
  Retracting a tariff recomputes costs and the optimal plan, but never
  changes physically executed shed.
- **Shed retraction is forbidden**: an executed shed is a physical fact. A
  `retract(kind="shed")` keeps the shed and appends a compensation record to
  `comp.jsonl` (`reason: SHED_RETRACT_FORBIDDEN`).
- **METER_ROLLBACK**: cumulative `kwh` moving backwards among surviving
  readings (including a negative first reading against the zero baseline)
  aborts the audit with exit code 1. A rollback that is itself retracted is
  accepted.

## Optimizer

Baseline demand per window = metered demand + executed shed (the shed was
physically real, so the unshed baseline is what the optimizer may re-decide).
Candidate loads come from executed shed events and are available in every
window; `--budget` caps sheddable kW per window (default: uncapped).

Objective: minimize peak cost `max_w (baseline_w - shed_w) * rate_w`.
Tie-breaks: less total shed kW, then all remaining tied plans are reported in
load-lexicographic order. With `<= 3` windows (or any small combination
count) the optimizer is exhaustive; larger inputs fall back to a greedy
heuristic (`settlement.json` reports `method`).

## Tests

```sh
node --test
```

See `RESULTS.md` for the latest recorded run.
