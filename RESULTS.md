# Test Results

Date: 2026-10-04
Runtime: Node.js v22.22.1 (linux x64), standard library only, `node:test`.

## Command

```sh
node --test
```

Aggregate summary reported by the test runner (one top-level entry per test file):

```
# tests 3
# pass 3
# fail 0
```

## Per-file breakdown (real individual test counts)

| File | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `test/acceptance.test.js` | 11 | 11 | 0 |
| `test/cli.test.js` | 4 | 4 | 0 |
| `test/enumeration.test.js` | 1 | 1 | 0 |
| **Total** | **16** | **16** | **0** |

- Acceptance 1 (3 alarms acked in window; repeat ack returns 0, no duplicate
  records; empty window is a legal no-op): covered by `test/acceptance.test.js`.
- Acceptance 2 (concurrent insert into a scanned window -> one committer ok,
  the other `E_PHANTOM`; different device / disjoint window do not conflict):
  covered by `test/acceptance.test.js`.
- Acceptance 3 (exhaustive enumeration of 2-transaction histories over <= 4
  seeded alarms, compared op-by-op against a naive array reference that
  re-checks predicates at commit point): `test/enumeration.test.js` executed
  **7,860** enumerated histories, all matching the reference, with ack-log
  invariants (no duplicate records) checked after every run.

## Notes

- The sandbox blocks spawning nested `node` processes (EPERM), so
  `test/cli.test.js` exercises the CLI through its pure `run(raw)` entry
  point (`src/cli.js`). Real-process exit codes were verified manually:
  happy path = 0, phantom conflict = 1, malformed input = 2.
