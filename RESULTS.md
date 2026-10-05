# Actual recorded results

Environment: Node v22.22.1, tsc Version 7.0.2

## `npm test`

```

> pbt-contract@0.1.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/check.test.js
ok 1 - dist/test/check.test.js
  ---
  duration_ms: 464.012079
  type: 'test'
  ...
# Subtest: dist/test/gen.test.js
ok 2 - dist/test/gen.test.js
  ---
  duration_ms: 496.53843
  type: 'test'
  ...
# Subtest: dist/test/history.test.js
ok 3 - dist/test/history.test.js
  ---
  duration_ms: 460.208446
  type: 'test'
  ...
# Subtest: dist/test/resume.test.js
ok 4 - dist/test/resume.test.js
  ---
  duration_ms: 425.133868
  type: 'test'
  ...
# Subtest: dist/test/rng.test.js
ok 5 - dist/test/rng.test.js
  ---
  duration_ms: 433.765957
  type: 'test'
  ...
# Subtest: dist/test/shrink.test.js
ok 6 - dist/test/shrink.test.js
  ---
  duration_ms: 471.247201
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 541.485304
```

## `npm run demo`

```

> pbt-contract@0.1.0 demo
> tsc -p tsconfig.json && node dist/examples/demo.js

status:      falsified
seed:        demo-seed
counterex.:  [1,3,7,7,12,15]
minimal:     [11]
shrink steps: 4, shrink tests: 10
trace (first 12 entries):
  #0 generate fail [1,3,7,7,12,15]
  #0 shrink pass [1]
  #1 shrink fail [7,12,15]
  #2 shrink pass [7]
  #3 shrink fail [12,15]
  #4 shrink fail [12]
  #5 shrink pass [0]
  #6 shrink pass [6]
  #7 shrink pass [9]
  #8 shrink fail [11]
  #9 shrink skip [0]
  #10 shrink skip [6]
trace total: 14 entries

checkpoint after 2 tests (complete=false), 382 bytes of JSON
resumed: 14 more tests, minimal=[30]
single-step irreducible: true
```
