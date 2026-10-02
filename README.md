# pressline-oee

Offline OEE downtime attribution for a stamping line. Consumes a noisy event stream
(`run` / `idle` / `fault` / `changeover` / `maintenance` — possibly out-of-order,
overlapping, duplicated, or with clock rollback) and produces a normalized timeline,
per-segment planned/unplanned labels with reasons, OEE with downtime attribution,
replayable fault-injection certificates, and minimal counterexamples for disputed
segments. Node.js 22, standard library only, tests with `node:test`.

## Model

Events are half-open intervals `{ id, type, start, end }` (ms). Arrival order = array
order. Normalization pipeline (`analyze`):

1. **Schema validation** — malformed events/params → `ERR_SCHEMA`.
2. **Dedup / conflict** — same `id` + same payload collapses (injected duplicates never
   double-count); same `id` + different payload → `ERR_CONFLICT`.
3. **Clock check** — an event starting before `maxStartSeen - maxSkewMs` → `ERR_CLOCK`;
   the whole batch is rejected, state unchanged (see `Line.ingest`).
4. **Sweep-line segmentation** — boundary points from all starts/ends; per elementary
   interval the highest-priority active event wins:
   `fault(50) > maintenance(40) > changeover(30) > idle(20) > run(10)`, ties by smaller
   id. Gaps become `uncovered`. Zero-duration events carry no interval.
5. **Post-processing** — adjacent same-state segments merge; segments shorter than
   `minSegmentMs` are absorbed into the higher-priority neighbor (tie: left), shortest
   first, to a fixpoint.

### Labels (priority rules coupled with threshold parameters)

| state        | planned   | rule                                                        |
|--------------|-----------|-------------------------------------------------------------|
| `run`        | yes       | productive time                                             |
| `maintenance`| yes       | planned by type                                             |
| `changeover` | threshold | planned iff merged duration ≤ `changeoverPlannedBudgetMs`   |
| `idle`       | no        | unplanned by rule                                           |
| `fault`      | no        | unplanned by rule                                           |
| `uncovered`  | no        | no event covers the interval                                |

Every segment carries `reason` (e.g. `changeover 3600000ms > budget 1800000ms ->
unplanned`) and `sources` (contributing event ids) — that is the proof of *why* a
segment was judged unplanned.

### OEE

`plannedProductionMs = totalMs - plannedDowntimeMs` (planned downtime = planned
non-`run` segments); `availability = (plannedProductionMs - unplannedDowntimeMs) /
plannedProductionMs`; `oee = availability × performance × quality`. Overlapping
downtime is unioned, never double-counted. Edge conventions: empty stream →
`oee: null`; all-day planned maintenance → `availability = 1` (no losses possible).

### Fault injection & certificate

`injectFaults(events, spec)` supports `lost`, `duplicate` (exact copies, same id),
`skew` (shift start/end by `deltaMs`), each as explicit ids or seeded counts
(`mulberry32`). The **resolved** spec lands in `certificate.injection` together with
`inputHash`/`outputHash` (sha256 over canonical JSON); `replay(certificate, events)`
re-applies it and verifies both hashes — injections are deterministic and replayable.

### Disputes & minimal counterexamples

`dispute({ events, params, interval })` classifies the interval (by its midpoint's
segment) and returns:

- `minimalSubset` — greedy ddmin-style 1-minimal event subset that still reproduces
  the verdict (`oneMinimal: true` means removing any remaining event flips it);
- `flip` — for an `unplanned` verdict, the minimal change making it `planned`:
  single shrinks (cut an event at the interval boundary) → single deletions →
  deletion pairs.

## API

```js
import { analyze, dispute, replay, injectFaults, Line, referenceTimeline, ERR } from './src/index.js';

analyze({ events, params?, injection? }); // { ok, timeline, oee, certificate } | { ok:false, error }
dispute({ events, params?, interval });   // { ok, verdict, minimalSubset, oneMinimal, flip }
replay(certificate, rawEvents);           // { ok, match }
const line = new Line(params);            // stateful; ingest() is atomic on ERR_*
line.ingest(batch); line.analyze();
```

Params (defaults): `maxSkewMs` 300000, `minSegmentMs` 0,
`changeoverPlannedBudgetMs` 1800000, `performance` 1, `quality` 1.
Error codes: `ERR_SCHEMA` (bad input), `ERR_CLOCK` (rollback > maxSkewMs, state
unchanged), `ERR_CONFLICT` (same id, different payload).

## Verification

- **Acceptance 1** — `test/timeline.test.js` fuzzes 300 seeds × 0–14 random events and
  random thresholds, asserting the sweep pipeline equals `referenceTimeline`, an
  independent brute-force O(boundaries × events) re-implementation (`src/reference.js`,
  shares only the priority table).
- **Acceptance 2** — `test/clock.test.js`: rollback beyond `maxSkewMs` → `ERR_CLOCK`,
  `Line` state deep-equal to before the failed ingest.
- **Acceptance 3** — `test/injection.test.js`: a fault duplicated 5× yields
  byte-identical `timeline` and `oee`; certificate replay matches.
- **Acceptance 4** — `test/dispute.test.js`: disputed segment → 1-minimal repro subset
  (verified by re-analysis) and minimal flip (shrink / deletion / pair).

## Real test results

`node --test` on Node v22.22.1 (this workspace, 2026-10-03):

```
ok 1 - test/clock.test.js
ok 2 - test/dispute.test.js
ok 3 - test/errors.test.js
ok 4 - test/injection.test.js
ok 5 - test/timeline.test.js
# tests 5
# pass 5
# fail 0
```

Per-file subtests (run individually): clock 3/3, dispute 6/6, errors 3/3,
injection 5/5, timeline 9/9 — **26/26 passing**, including the 300-seed ≤14-event
sweep-vs-reference fuzz.

## Layout

```
src/errors.js     error codes + OeeError
src/validate.js   schema, dedup/conflict, clock check, params, PRIORITY
src/timeline.js   sweep-line, merge/absorb, classify, OEE
src/reference.js  independent naive reference (test oracle)
src/inject.js     seeded fault injection (skew/lost/duplicate)
src/analyze.js    analyze() + certificate + replay()
src/dispute.js    minimal repro subset + minimal flip
src/line.js       stateful Line with atomic ingest()
test/             node:test suites
```
