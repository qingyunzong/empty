# Test Results

Recorded on 2026-10-05, Node.js v22.22.1, tsc 7.0.2, Linux x86_64.

## `npm test`

```

> transfer-cli@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
  ---
  duration_ms: 2712.825679
  type: 'test'
  ...
# Subtest: dist/test/enumeration.test.js
ok 2 - dist/test/enumeration.test.js
  ---
  duration_ms: 1168.243756
  type: 'test'
  ...
# Subtest: dist/test/mincostflow.test.js
ok 3 - dist/test/mincostflow.test.js
  ---
  duration_ms: 541.648022
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2755.653128
```

## Per-file detail (node dist/test/<file>.test.js)

```
=== dist/test/mincostflow.test.js ===
ok 1 - piecewise fees: cheapest units are used first across parallel edges
ok 2 - negative fees: exact amount vs at-most amount
ok 3 - infeasible amount reports max flow
ok 4 - zero amount is a trivial optimal flow
ok 5 - negative-cost cycles in the input are rejected
ok 6 - non-convex (decreasing) marginal fees are rejected
ok 7 - amount above 20 is rejected
ok 8 - full 20-unit transfer solves and certifies
ok 9 - certificate catches tampered potentials
ok 10 - certificate catches tampered flow conservation
# tests 10
# pass 10
# fail 0
=== dist/test/enumeration.test.js ===
ok 1 - solver matches brute-force enumeration on random small networks (exact)
ok 2 - solver matches brute-force enumeration on random small networks (at-most)
# tests 2
# pass 2
# fail 0
=== dist/test/cli.test.js ===
ok 1 - CLI solves a network from a file and prints the certificate
ok 2 - CLI --enumerate agrees with the solver
ok 3 - CLI --amount override (exact)
ok 4 - CLI --at-most with negative fees sends the profitable amount
ok 5 - CLI exits 2 on infeasible and 1 on invalid input
# tests 5
# pass 5
# fail 0
```
