# Test results (real run)

Date: 2026-10-03 19:21:23 UTC, node v22.22.1

## `node --test`

```
TAP version 13
# Subtest: test/analyze.test.js
ok 1 - test/analyze.test.js
  ---
  duration_ms: 1461.164245
  type: 'test'
  ...
# Subtest: test/cli.test.js
ok 2 - test/cli.test.js
  ---
  duration_ms: 2140.367409
  type: 'test'
  ...
# Subtest: test/fraction.test.js
ok 3 - test/fraction.test.js
  ---
  duration_ms: 1305.267639
  type: 'test'
  ...
# Subtest: test/geometry.test.js
ok 4 - test/geometry.test.js
  ---
  duration_ms: 2573.847121
  type: 'test'
  ...
# Subtest: test/transactions.test.js
ok 5 - test/transactions.test.js
  ---
  duration_ms: 1610.713082
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3162.001339
```

## CLI smoke checks (real pipes)

```
$ echo '{"vertices":[[0,0],[4,0],[4,4],[0,4]],"segment":[[1,1],[3,1]]}' | node cli.js
{"ok": true, "status": "inside", "gapSquared": "1", "nearestEdge": 0, "pointOnEdge": {"x": "1", "y": "0"}, "tEdge": "1/4"}
$ echo '{bad json' | node cli.js ; echo exit=\$?
{"ok":false,"error":{"code":"E_PARSE","message":"invalid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)"}}
exit=1
```
