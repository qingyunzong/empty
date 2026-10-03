# RESULTS

Environment: Node.js v22.22.1, standard library + `node:test` only, single
machine, offline. All outputs below are real runs (2026-10-04, Asia/Shanghai).

## Test suite

`node --test test/*.test.js`:

```
ok 1 - test/crash.test.js
ok 2 - test/enumerate.test.js
ok 3 - test/replay.test.js
ok 4 - test/tie.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 7443.660812
```

## Acceptance criteria

1. **10k tx across 50 rule versions — interval replay hash equals full run**
   (`test/replay.test.js`, ok): 50 hourly rule versions, 10,000 seeded-random
   transactions. Full-range `verify` reports `match: true`
   (`settledHash === replayHash`); 25 random sub-intervals each reproduce the
   identical hash, and 5 tiling slices sum to the full-range `totalFee`.

2. **Kill before checkpoint write — recovery neither skips nor duplicates
   backfills** (`test/crash.test.js`, ok): a worker thread runs `sync` and
   busy-loops right after the journal fsync, before the checkpoint write; the
   parent hard-kills it with `worker.terminate()`. Post-kill state: checkpoint
   untouched, journal already holds the 43 new records (91 settled). Recovery
   `sync` reports `consumed: 43, appended: 0, replayed: 43` — every replayed
   line reproduces its journaled record exactly and is skipped. Corrections
   (`tx-3` → fee 999, `tx-7` → fee 555, late `tx-late` → fee 77) are applied
   exactly once, and the recovered state deep-equals a clean single-pass run.
   (The sandbox forbids spawning child processes, so the "process kill" uses a
   terminated worker thread; `SYNC_CRASH_AFTER_JOURNAL=1` provides the same
   crash window with a real SIGKILL for un-sandboxed CLI runs.)

3. **n ≤ 8 rules — enumerated effective windows cross-checked**
   (`test/enumerate.test.js`, ok): 200 random trials of 2–8 rules (random
   windows, revokes, forced rate ties). Every atomic window boundary, midpoint
   and edge sample is checked against an independent brute-force linear scan;
   selected rule, best rate and fees all agree.

4. **Tied best rate — stable full report, explainable final fee**
   (`test/tie.test.js`, ok): two runs of `fee` produce byte-identical output;
   all tied rules are listed in fixed order (priority desc, ruleId asc) and
   `reason` documents the tie-break. Also covered: overlap without declared
   priority exits `code=40`; unmarked late tx / duplicate txId / rule event
   regression exit `code=41`; revoke preserves pre-revoke history.

## CLI demo (examples/)

`node cli.js sync --rules examples/rules.ndjson --tx examples/tx.ndjson --state examples/state`:

```json
{ "consumed": 4, "appended": 4, "replayed": 0, "corrections": 0, "settledCount": 4, "rulesCount": 4 }
```

`node cli.js fee --state examples/state --txId t-002` (excerpt — two promo
rules tie at 80bps, both reported, `promo-b` wins on priority):

```json
{
  "bestRateBps": 80,
  "tied": [ { "ruleId": "promo-b", "priority": 2 }, { "ruleId": "promo-a", "priority": 1 } ],
  "selected": { "ruleId": "promo-b", "priority": 2 },
  "reason": "2 rules tie for best rate 80bps; selected by fixed order (priority desc, ruleId asc)",
  "fee": 2000
}
```

Backfill correction into the settled range
(`{"txId":"t-002","time":1700040000000,"amount":300000,"backfill":true}` appended,
then `node cli.js sync --state examples/state`):

```json
{ "consumed": 1, "appended": 1, "replayed": 0, "corrections": 1, "settledCount": 4 }
```

`t-002` now settles at fee 2400 (incremental correction, no full recompute).

`node cli.js verify --state examples/state --from 1700030000000 --to 1700060000000`:

```json
{
  "count": 2,
  "totalFee": 3040,
  "settledHash": "271a6831b0026d66362cb82dc165f0245c1f476d4a52efd0ba747360fd95db40",
  "replayHash": "271a6831b0026d66362cb82dc165f0245c1f476d4a52efd0ba747360fd95db40",
  "match": true
}
```

Full-range verify after the correction: `count: 4, totalFee: 6040, match: true`.

## Error exits (real runs)

```
$ node cli.js sync --rules rules.ndjson --tx tx.ndjson --state s1   # x,y tie at 100bps, no priority
{"error":"overlapping rules tie for best rate 100bps at t=2000 without declared priority: x, y","code":40}
exit=40

$ node cli.js sync --rules rules2.ndjson --tx tx2.ndjson --state s2  # tx times 5000 then 3000
{"error":"tx line 2: time 3000 goes backwards (last processed 5000); mark legitimate late arrivals with \"backfill\": true","code":41}
exit=41
```
