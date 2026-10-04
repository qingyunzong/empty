# Test Results (real recorded output)

Date: 2026-10-04T16:17:25Z  
Runtime: v22.22.1  
Command: `node --test`

```
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
# Subtest: test/certificate.test.js
ok 2 - test/certificate.test.js
# Subtest: test/incremental.test.js
ok 3 - test/incremental.test.js
# Subtest: test/simulator.test.js
ok 4 - test/simulator.test.js
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1177.317394
```

Per-file subtest counts:

```
== test/acceptance.test.js
# tests 5
# pass 4
# fail 0
# skipped 1
== test/certificate.test.js
# tests 5
# pass 5
# fail 0
# skipped 0
== test/incremental.test.js
# tests 3
# pass 3
# fail 0
# skipped 0
== test/simulator.test.js
# tests 11
# pass 11
# fail 0
# skipped 0
```

Note: the cross-process seed-consistency test is skipped in sandboxes that
forbid child processes (EPERM here); the PRNG is pure integer arithmetic,
so determinism holds by construction. It runs where spawn is permitted.
