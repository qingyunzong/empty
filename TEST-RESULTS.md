# Test Results

Date: 2026-10-02 20:40:54 UTC
Node: v22.22.1
Command: `node --test` (plus per-file runs for individual test detail)

## `node --test` (suite summary)

```
ok 1 - test/acceptance.test.js
ok 2 - test/cli.test.js
ok 3 - test/graph.test.js
ok 4 - test/persistence.test.js
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## test/acceptance.test.js

```
ok 1 - A1: revoking a source degrades a three-level derivation chain
ok 2 - A2: restore does not resurrect a subsequently removed fact
ok 3 - A3: 100-node random graphs match reference closure enumeration
ok 4 - A4: fault injection at all three points recovers deterministically
# tests 4
# pass 4
# fail 0
```

## test/cli.test.js

```
ok 1 - CLI: full add/derive/revoke/restore/status/verifylog flow
ok 2 - CLI: cycle rejected with E_CYCLE and exit code 1
ok 3 - CLI: revoke of unknown source fails with E_SOURCE_GONE
ok 4 - CLI: verifylog detects tampering with E_HASH
ok 5 - CLI: snapshot then verifylog still ok
# tests 5
# pass 5
# fail 0
```

## test/graph.test.js

```
ok 1 - count aggregation: valid only when enough premises valid
ok 2 - sum aggregation: sums values of valid premises
ok 3 - unknown: missing premise yields unknown, not degraded
ok 4 - unknown premise can still become valid and flip the node
ok 5 - cycle detection: mutual and self references rejected with E_CYCLE
ok 6 - three-level derivation degrades on revoke and recovers on restore
ok 7 - restore does not resurrect a fact removed after revoke
ok 8 - E_SOURCE_GONE for unknown source/fact/node operations
ok 9 - duplicate node ids rejected with E_DUP
ok 10 - state round-trips through toState/fromState
# tests 10
# pass 10
# fail 0
```

## test/persistence.test.js

```
ok 1 - reopen replays WAL and reproduces state
ok 2 - snapshot + further events recover to the same state
ok 3 - tampered WAL record fails with E_HASH
ok 4 - broken hash chain linkage fails with E_HASH
ok 5 - unparseable WAL record fails with E_WAL
ok 6 - tampered snapshot fails with E_HASH
ok 7 - crash injection at all three fault points recovers deterministically
ok 8 - verifylog reports head hash and event count
# tests 8
# pass 8
# fail 0
```
