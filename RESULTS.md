# RESULTS

Environment: Node.js v22.22.1 (Linux x64), standard library only.

## Test runs

`node --test` (run 3×, stable):

- exit code: 0
- test files: 1 passed, 0 failed (`test/acceptance.test.js`)

`node --test --experimental-test-isolation=none` (per-test detail):

- acceptance 1: fill capacity-3 slot with 3 units succeeds, 1 more fails with E_CAPACITY — **ok**
- acceptance 2: concurrent readers of same remaining capacity, one wins, other gets E_SNAPSHOT — **ok**
- acceptance 3: enumerated <=4 overlapping/adjacent ops match naive interval scan — **ok**
- acceptance 4: CLI processes JSON plan and reports E_CAPACITY / E_SNAPSHOT — **ok**
- **Totals: 4 tests, 4 passed, 0 failed** (~0.7–1.6 s)

## Acceptance coverage

1. **Capacity boundary** — capacity-3 slot accepts exactly 3 units (equal is
   allowed); one more unit, and any adjust to 4, abort with `E_CAPACITY`.
2. **Concurrent snapshot conflict** — two transactions read the same remaining
   capacity (3), insert different orders totalling 4: first commits (certificate
   with txId, commitTimestamp, predicate SHA-256 hashes), second aborts with
   `E_SNAPSHOT` (predicate re-validated against latest committed state).
   Non-overlapping slots commit concurrently without conflict.
3. **Index vs. naive reference** — exhaustive enumeration of all 4,680
   sequences of length ≤4 over 8 ops (insert/adjust/cancel on adjacent
   `[0,1)`/`[1,2)` and overlapping `[0,2)` intervals): 107,499 comparisons of
   the predicate secondary index against naive interval-scan summation, across
   every commit sequence, all equal. Snapshot reads taken before commits stay
   stable.
4. **CLI** — JSON plan in, per-command results out; certificate on success,
   `E_CAPACITY` / `E_SNAPSHOT` on conflict. Also smoke-tested as a real
   process: `node bin/cli.js plan.json`.

## Environment note

The CLI end-to-end test exercises `runPlan()` from `bin/cli.js` in-process
because this sandbox denies nested `spawnSync` (EPERM) from within Node; the
CLI binary itself was verified separately by piping JSON plans through
`node bin/cli.js` from the shell (works: certificate + E_SNAPSHOT shown above).
