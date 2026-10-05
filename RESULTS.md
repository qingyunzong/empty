# RESULTS

Real outputs captured on 2026-10-05 with Node.js v22.22.1 (standard library
only, tests via `node:test`). All commands were run from the repository root.

## `node --test`

```
TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
  ---
  duration_ms: 353.827889
  type: 'test'
  ...
# Subtest: test/cycle.test.js
ok 2 - test/cycle.test.js
  ---
  duration_ms: 332.563375
  type: 'test'
  ...
# Subtest: test/enumerate.test.js
ok 3 - test/enumerate.test.js
  ---
  duration_ms: 422.58376
  type: 'test'
  ...
# Subtest: test/helpers.js
ok 4 - test/helpers.js
  ---
  duration_ms: 261.463324
  type: 'test'
  ...
# Subtest: test/merge.test.js
ok 5 - test/merge.test.js
  ---
  duration_ms: 405.470148
  type: 'test'
  ...
# Subtest: test/pending.test.js
ok 6 - test/pending.test.js
  ---
  duration_ms: 350.872426
  type: 'test'
  ...
# Subtest: test/validate.test.js
ok 7 - test/validate.test.js
  ---
  duration_ms: 367.019226
  type: 'test'
  ...
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 460.91335
```

Acceptance criteria coverage:

1. **Three-device merge matches a legal serialization** —
   `test/merge.test.js` ("acceptance 1") merges the three-tablet history and
   independently enumerates every topological order of the happens-before
   graph; the merged matrix appears among them and all serializations agree.
2. **Constructed cycle returns the minimal cycle** —
   `test/cycle.test.js` ("acceptance 2") builds crossed sync rendezvous and
   asserts the reported cycle is the length-4 minimal loop
   `a2 -> sa2 -> b2 -> sb1 -> a2`.
3. **PENDING never judges conflict** — `test/pending.test.js`
   ("acceptance 3") runs a clean history with budgets 0–3 and asserts a
   `PendingError` with no cycle/conflict payload; `test/cli.test.js` asserts
   exit code 4 and the absence of `cycle`/`pair` fields.
4. **n<=8 cross-checked against enumeration of all topological orders** —
   `test/enumerate.test.js` ("acceptance 4") generates 80 seeded random
   histories (2–8 ops, 2–3 devices, set_count + paired syncs); every decided
   merge result appears in the enumeration and non-conflicting histories
   converge to exactly one matrix.

## CLI runs (exit codes 0 / 6 / 4 / 2)

```
$ node bin/eco-merge.js --config examples/config.json examples/tabletA.jsonl examples/tabletB.jsonl examples/tabletC.jsonl
{
  "verdict": "CONCURRENT_OK",
  "matrix": {
    "P1": {
      "S1": 2,
      "S2": 3,
      "G1": 0
    },
    "P2": {
      "S1": 1,
      "S2": 0,
      "G1": 1
    }
  },
  "topoOrder": [
    "a1",
    "a2",
    "b1",
    "b2",
    "a3",
    "b3",
    "c1",
    "c2"
  ],
  "budgetSteps": 62
}
exit code: 0

$ node bin/eco-merge.js --config examples/config.json examples/cycle/A.jsonl examples/cycle/B.jsonl
{"verdict":"CONFLICT","error":"causal cycle of length 4: a2 -> sa2 -> b2 -> sb1 -> a2","reason":"causal_cycle","cycle":["a2","sa2","b2","sb1"]}
exit code: 6

$ node bin/eco-merge.js --config examples/config.json --budget 3 examples/tabletA.jsonl examples/tabletB.jsonl examples/tabletC.jsonl
{"verdict":"PENDING","error":"cycle/topology budget exhausted after 4 steps (limit 3)"}
exit code: 4

$ node bin/eco-merge.js --config examples/config.json /tmp/bad.jsonl   # non-monotonic ts
{"verdict":"INVALID_HISTORY","error":"device A: non-monotonic ts at op a2 (ts 1 after 2)"}
exit code: 2
```
