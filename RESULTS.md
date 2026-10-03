# Test Results

Command: `node --test`
Node: v22.22.1
Date: 2026-10-03 (UTC)

## Summary (as reported by `node --test`)

- tests: 4
- pass: 4
- fail: 0
- cancelled: 0
- skipped: 0

`node --test` in this environment aggregates per test file (4 files). The
individual subtests inside each file all pass as well; running each file
directly shows:

- `test/basic.test.js`: 9/9 subtests pass
- `test/phantom.test.js`: 11/11 subtests pass
- `test/enumerate.test.js`: 1/1 subtests pass (55,376 enumerated histories, 0 mismatches vs the naive reference)
- `test/cli.test.js`: 7/7 subtests pass

Total: 28/28 subtests pass, 0 failures.

## Raw `node --test` output (summary)

```
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Coverage notes

- Acceptance 1 (3 alarms confirmed, idempotent re-confirm, no duplicate ack
  records): `test/basic.test.js`, `test/cli.test.js`.
- Acceptance 2 (phantom on concurrent insert in same window; different device
  / disjoint window do not conflict): `test/phantom.test.js`.
- Acceptance 3 (operation-history enumeration for <= 4 alarms and 2
  transactions checked against a naive array-based reference that re-checks
  the predicate at commit): `test/enumerate.test.js`.
