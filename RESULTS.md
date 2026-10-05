# Actual results

Recorded on 2026-10-05, Node.js v22.22.1, TypeScript 7.0.2, offline
environment (no network access).

## `npm test`

```
> certpath-cli@1.0.0 test
> npm run build && node --test dist/test/*.test.js

ok 1 - dist/test/cli.test.js
ok 2 - dist/test/crosscheck.test.js
ok 3 - dist/test/pathfinder.test.js
# tests 3
# suites 0
# pass 3
# fail 0
```

Per-file detail (`node --test-reporter=spec dist/test/<file>`):

```
pathfinder.test.js:  ✔ findPath  ✔ parseGraph input validation   tests 20, pass 20, fail 0
crosscheck.test.js:  ✔ cross-check: pruned search vs simple path enumeration   tests 2, pass 2, fail 0
cli.test.js:         ✔ cli                                          tests 11, pass 11, fail 0
```

Total: 33 individual tests, 33 passed, 0 failed. The cross-check compares
the pruned search against brute-force simple-path enumeration on 600
randomized graphs with max lengths 1..14 plus 300 graphs at the default
12-certificate limit (seeded LCG, deterministic); both outcomes (path found
/ no path) are exercised and the run asserts the corpus is not one-sided.

## CLI demo runs (fixtures/sample.json)

```
$ node dist/src/cli.js fixtures/sample.json --leaf leaf --usage serverAuth
OK path (3 certificates): leaf -> ca-a -> root-z        (exit 0)

$ node dist/src/cli.js fixtures/sample.json --leaf leaf --usage clientAuth
OK path (3 certificates): leaf -> ca-a -> root-z        (exit 0)

$ node dist/src/cli.js fixtures/sample.json --leaf leaf --usage emailProtection
FAIL [LEAF_USAGE_MISMATCH] leaf certificate "leaf" does not allow usage "emailProtection"   (exit 1)

$ node dist/src/cli.js fixtures/sample.json --leaf leaf --usage serverAuth --max-length 2
FAIL [PATH_TOO_LONG] shortest chain to a trusted root needs 3 certificates, exceeding the maximum of 2   (exit 1)

$ node dist/src/cli.js fixtures/sample.json --leaf leaf --usage serverAuth --json
{
  "ok": true,
  "path": [
    "leaf",
    "ca-a",
    "root-z"
  ]
}
```

Note: `fixtures/sample.json` offers two length-3 chains
(`leaf -> ca-a -> root-z` and `leaf -> ca-b -> root-a`); the id-order
tie-break selects the `ca-a` chain.
