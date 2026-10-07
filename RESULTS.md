# RESULTS

Recorded from real runs on 2026-10-07, Node v22.22.1, Linux x86_64.

## `node --test` (required command)

- Exit code: **0**
- Test files: **4 passed, 0 failed** (`test/acceptance.test.js`,
  `test/cli.test.js`, `test/edge-cases.test.js`, `test/enumeration.test.js`)
- Duration: ~1.0 s

```
# tests 4
# pass 4
# fail 0
```

`node --test` aggregates at file granularity; individual `node:test` cases
per file (run directly) total **22 passed, 0 failed**:

| File | Cases | Pass | Fail |
| --- | --- | --- | --- |
| test/acceptance.test.js | 5 | 5 | 0 |
| test/cli.test.js | 7 | 7 | 0 |
| test/edge-cases.test.js | 9 | 9 | 0 |
| test/enumeration.test.js | 1 (3276 histories) | 1 | 0 |
| **Total** | **22** | **22** | **0** |

## Acceptance coverage

1. **Concurrent same-slot writes**: two transactions writing the same
   `(workcenter, timeSlot)` — first commit succeeds, second fails with
   `E_UNIQUE`; disjoint timeSlots both commit. ✔ (`test/acceptance.test.js`,
   `test/cli.test.js`)
2. **Snapshot stability**: a transaction begun before 3 later commits still
   reads the begin-time work-order set, and its attempt to overwrite a key
   modified by a newer version fails with `E_SNAPSHOT`. ✔
   (`test/acceptance.test.js`)
3. **Exhaustive enumeration**: all **3276** histories of ≤2 transactions and
   ≤4 operations (begin/get/put/commit/abort over keys `""`,`a`,`b` and
   values `""`,`{w1,t1}`,`{w1,t2}`) produce results identical to the naive
   copy-array reference (`reference/ref-store.js`), including final committed
   state. ✔ (`test/enumeration.test.js`)

## Edge cases

Empty key, zero-length work order (`""`), same-value duplicate writes,
empty-string `workcenter`/`timeSlot` index entries, non-object values
skipping the index, slot reuse after move, abort semantics, usage errors —
all covered in `test/edge-cases.test.js` and `test/cli.test.js`. ✔

## CLI process-level smoke (real `node cli.js` runs)

- Unique conflict batch → exit **1**, stderr
  `{"code":"E_UNIQUE","message":"..."}` ✔
- Invalid JSON input → exit **2**, stderr
  `{"code":"E_USAGE","message":"invalid JSON on line 1"}` ✔
- Valid batch → exit **0**, canonical JSON lines on stdout ✔

Note: `test/cli.test.js` drives the CLI in-process via the pure
`runCli(argv, stdin)` export because the development sandbox blocks
`child_process` spawning (EPERM); the thin process wrapper in `cli.js` maps
the returned `{status, stdout, stderr}` verbatim onto the real process
streams and exit code, verified by the smoke runs above.
