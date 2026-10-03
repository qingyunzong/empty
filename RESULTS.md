# Test Results

- Command: `node --test`
- Node: v22.22.1
- Date: 2026-10-03 (Asia/Shanghai)
- Exit code: 0

## Summary (actual runner output)

```
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 884.853887
```

## Per-file results

```
ok 1 - test/acceptance1-late-cancel.test.js
ok 2 - test/acceptance2-boundary.test.js
ok 3 - test/acceptance3-cycles.test.js
ok 4 - test/acceptance4-errors.test.js
ok 5 - test/helpers.js
ok 6 - test/retract.test.js
ok 7 - test/watermark.test.js
```

## Acceptance coverage

1. Three-AGV cycle resolved by one late cancel —
   `test/acceptance1-late-cancel.test.js` (cert in `cycles.json`, matching
   `invalidated: true` record with the original hash in `invalid.jsonl`,
   cancel logged in `late.log`, `B->A` wait edge removed).
2. Endpoint-touching overlap is not a wait —
   `test/acceptance2-boundary.test.js` (both directions, empty `waits.jsonl`
   and `cycles.json`).
3. Exhaustive cross-check of all directed graphs on <= 4 nodes (4/64/4096
   graphs for n = 2..4 via independent permutation-based brute force) plus 300
   seeded random interval-overlap trials validated segment-by-segment —
   `test/acceptance3-cycles.test.js`.
4. Duplicate `reserveId` -> `DUP_RESERVE` (exit 2) —
   `test/acceptance4-errors.test.js`; also `UNKNOWN_AGV` (exit 3) for pings of
   unknown AGVs.
