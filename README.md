# clearing-daycut

Clearing-house settlement day-cut library and CLI. Node.js 22, standard
library only (`node:test`, `node:crypto`, `node:util`, `node:fs`), fully
offline: timezone rules are supplied as versioned input data, never read
from the system tzdb.

## Layout

- `src/civil.js` — timezone-free civil-date math at minute precision
- `src/tztable.js` — versioned tz tables; local→UTC with DST gap/overlap detection
- `src/calendar.js` — business calendars, settlement intervals, interval merging
- `src/settle.js` — append-only engine; reversals; per-day nets; affected-day recompute
- `src/certificate.js` — verifiable certificate, replay, report verification
- `src/cli.js` + `bin/clearing.js` — CLI (`runCli` is importable for tests)
- `examples/` — tzdb `2024a` (NY/London/Shanghai), three calendars, sample flows
- `test/` — `node --test` suites incl. an independent minute-enumeration reference

## Core semantics

- Settlement day `D` owns the half-open local interval
  `[cutoff(prevBusinessDay(D)), cutoff(D))`. A transaction exactly on the
  cutoff belongs to the **later** day and is recorded in `boundaryHits`.
- Local→UTC resolution uses the supplied tz table. A local time claimed by
  zero segments (spring-forward gap) raises `E_GAP`; claimed by two segments
  (fall-back overlap) raises `E_OVERLAP` with both candidate UTC instants.
  Illegal/ambiguous local times are **rejected, never silently shifted**.
- Corrections are append-only: a `reversal` flow references the original
  `id`; history is never deleted. Applying a batch recomputes only the
  settlement days it touches (`affectedDays`); all other days keep their
  stored nets.
- Flows whose settlement date falls beyond the calendar `horizon` are not
  errors; they are parked in `pending` with reason `CALENDAR_HORIZON`.
- All timestamps are minute-precision (`YYYY-MM-DDTHH:MM` local,
  `YYYY-MM-DDTHH:MMZ` UTC); amounts are integer minor units.

## Inputs

- `tzdb.json` — `{ "version": "2024a", "zones": { name: { "segments": [
  { "utcStart": "...Z", "offsetMinutes": n }, ... ] } } }`; each segment
  covers `[utcStart, next.utcStart)`, last is open-ended.
- `calendars.json` — array of `{ id, version, zone, cutoff: "HH:MM",
  weekend: [0,6], holidays: ["YYYY-MM-DD"], horizon: "YYYY-MM-DD" }`.
- `flows.json` — append-only batch, `seq` strictly increasing across
  batches: `{ id, seq, account, calendar, type: "post"|"reversal", amount,
  currency, localTime, ref? }`.

## CLI

```
clearing settle --tzdb F --calendars F --flows F [--state-in F] [--state-out F] [--out F]
clearing verify --tzdb F --calendars F --flows F --report F
```

`settle` applies a batch (optionally continuing from `--state-in`) and
emits a report: per-account/day/currency nets, pending reasons, and a
certificate (`inputHash`, `ruleVersion`, merged settlement `intervals`,
`boundaryHits`, `affectedDays`, `resultsHash`). `verify` replays the full
flow history from the raw inputs and checks the stored report.

Exit codes: `0` ok · `1` unexpected/verify-failed · `2` `E_INPUT` ·
`3` `E_TZ_UNKNOWN` · `4` `E_GAP` · `5` `E_OVERLAP` · `6` `E_ORDER`.

### Real example output (this repo, examples/)

```
$ node bin/clearing.js settle --tzdb examples/tzdb.json --calendars examples/calendars.json \
    --flows examples/flows.json --out report.json --state-out state.json
settle ok: {"applied":5,"affectedDays":4,"pending":0,"inputHash":"72dfab28c9d8510874934895297f51459980c2059b2b1c5893d9a27484165acf","resultsHash":"a29d66e49643e7508d8c040458e38c29687adba20358a6fe14e577545fbe4e0b"}

$ node bin/clearing.js verify --tzdb examples/tzdb.json --calendars examples/calendars.json \
    --flows examples/flows.json --report report.json
verify ok: inputHash=72dfab28c9d8510874934895297f51459980c2059b2b1c5893d9a27484165acf resultsHash=a29d66e49643e7508d8c040458e38c29687adba20358a6fe14e577545fbe4e0b
```

The example flows are one instant (`2024-06-10T15:00Z`) booked in three
markets plus a same-day reversal; resulting nets:

```
CN-SHA  2024-06-11  ACME  CNY  100000   (23:00 local, past 17:00 cutoff)
GB-LON  2024-06-10  ACME  GBP  100000   (16:00 local)
US-NY   2024-06-10  ACME  USD  100000   (11:00 local)
US-NY   2024-06-11  ACME  USD       0   (post 2500 + reversal -2500)
```

DST gap rejection (exit code 4):

```
$ node bin/clearing.js settle --tzdb examples/tzdb.json --calendars examples/calendars.json --flows gap-flow.json
ERROR E_GAP: local time 2024-03-10T02:30 does not exist in America/New_York (DST gap)
details: {"zone":"America/New_York","local":"2024-03-10T02:30"}
(exit=4)
```

## Tests

```
node --test
```

Real output summary (this repo, Node v22.22.1):

```
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 39878.180214
```

### Acceptance mapping

1. **NY/London/Shanghai same-day cut** — `test/acceptance.test.js` books one
   UTC instant in all three zones and asserts the three settlement dates
   (Shanghai rolls to the next day past the 17:00 cutoff).
2. **DST gap/overlap** — one flow at `2024-03-10T02:30` NY → `E_GAP`, one at
   `2024-11-03T01:30` NY → `E_OVERLAP`; lib tests and CLI exit-code tests
   (4/5) confirm rejection instead of silent shifting.
3. **Reversal recompute** — `test/settle.test.js` appends reversals and
   asserts only the touched days appear in `affectedDays`, untouched days
   are deep-equal to their prior state, history entries are preserved, and
   `verifyReport` against a full replay returns zero mismatches.
4. **Random cross-check** — three seeded 300-flow batches are compared
   against `test/reference.js`, an independent implementation that shares
   no code with `src/`: it enumerates every local minute in the covered
   range, never converts to UTC, and derives nets by table lookup. Nets,
   boundary-hit id sets, and pending id sets must match exactly.
