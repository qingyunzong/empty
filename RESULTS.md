# RESULTS

Date: 2026-10-03 17:24:04 CST  Node: v22.22.1  (single machine, offline)

## Test suite

```
$ node --test
ok 1 - test/acceptance.test.js
ok 2 - test/cli.test.js
ok 3 - test/reference.js
ok 4 - test/units.test.js
tests 4
pass 4
fail 0
duration_ms 5228.61352
```

Per-file detail:

```
$ node --test test/acceptance.test.js
  tests 1
  pass 1
  fail 0
$ node --test test/cli.test.js
  tests 1
  pass 1
  fail 0
$ node --test test/units.test.js
  tests 1
  pass 1
  fail 0
```

## Acceptance criteria mapping

- (1) three concurrent ops, one ok one fail: test/acceptance.test.js "three concurrent ops" -> PASS, valid orders [r1 r2 r3],[r1 r3 r2],[r3 r1 r2]
- (2) PENDING not rejected: "pending op is not treated as failure" + "pending op effects are considered" -> PASS (status PENDING, exit 3)
- (3) duplicate release: "duplicate release of the same reserve raises E_TYPE" -> PASS
- (4) random n<=8 vs brute-force permutations: "random histories (n <= 8) match brute-force reference" (40 seeded trials) -> PASS
- (5) over-bound: "history larger than --max yields E_BOUND" + CLI exit 4 -> PASS

## CLI runs (real output)

```
$ node bin/limit.js check examples/spec.lim examples/history-ok.json; echo exit=$?
status: OK
explored: 1 interleavings
linearizations: 1
r1 r2 c1 x1
exit=0

$ node bin/limit.js check examples/spec.lim examples/history-pending.json; echo exit=$?
status: PENDING
pending: r2 (unknown response; not treated as failure)
explored: 2 interleavings
linearizations: 1
r1 r2
exit=3

$ node bin/limit.js check examples/spec.lim examples/history-bad.json; echo exit=$?
status: E_LINEAR
explored: 1 interleavings
linearizations: 0
exit=2

$ node bin/limit.js check examples/spec.lim examples/history-9ops.json --max 8; echo exit=$?
E_BOUND: history has 9 operations, exceeds --max 8
exit=4
```
