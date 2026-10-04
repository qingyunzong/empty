# Test Results

Command: `node --test` (Node.js v22.22.1, linux x64)
Date: 2026-10-04 (Asia/Shanghai)

## Summary

- Test files: 5 total, **5 passed, 0 failed**
- Individual tests: 26 total, **26 passed, 0 failed**
- Total duration: ~99 s (dominated by the exhaustive enumeration test)

Per-file breakdown (subtests):

| File | Passed | Failed |
| --- | --- | --- |
| `test/store.test.js` | 13 | 0 |
| `test/persistence.test.js` | 3 | 0 |
| `test/cli.test.js` | 9 | 0 |
| `test/enumeration.test.js` | 1 | 0 |
| `test/helpers/reference.js` | 0 (helper, no tests) | 0 |

## Acceptance coverage

1. **Concurrent unique-index conflicts** — `test/store.test.js`:
   two transactions writing the same `(workcenter, timeSlot)` → first commit
   succeeds, second fails with `E_UNIQUE`; different slots/workcenters commit
   concurrently. CLI-level exit code 1 verified in `test/cli.test.js`.
2. **Snapshot stability** — `test/store.test.js`: a snapshot taken at `begin`
   still reads the original work-order set after 5 later commits (including
   overwrites of read keys), and a stale snapshot that tries to overwrite a
   newer version fails with `E_SNAPSHOT`.
3. **Exhaustive enumeration** — `test/enumeration.test.js`: all **416,444**
   histories with ≤ 2 transactions and ≤ 4 get/put operations (keys `""` and
   `"a"`, two indexed work-order values, each transaction closed by commit or
   abort, all interleavings) produce identical observable behavior in the real
   MVCC store and the naive "copy array + visibility rules" reference
   (`test/helpers/reference.js`).

## Edge cases

- Empty key `""` round-trips through store, disk log, and CLI.
- Zero-length work order (`""` value) round-trips and is not unique-indexed.
- Same-value repeated writes (within one tx, and re-writing an identical
  committed value) commit cleanly.
- Empty-object work orders are stored but not indexed; deletes (`null`)
  free their index slots; atomic slot swaps inside one commit are allowed.
- Persistence: commits replay from `log.jsonl` after reopen; the unique
  index is still enforced in the new process.
