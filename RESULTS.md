# Test Results

Command: `node --test`
Date: 2026-10-03
Node: v22.22.1 (stdlib only)

## Exit code

```
node --test ; echo $?
0
```

**Real exit code: 0** (6 tests passed, 0 failed)

## Coverage vs acceptance criteria

| # | Criterion | Test | Result |
|---|-----------|------|--------|
| A | NULL amounts/fees + duplicate keys | `A: NULL semantics...`, `A2`, `A3` | pass |
| B | index on/off: identical results, different plans | `B: --no-index yields identical results but a different plan` | pass |
| C | 100 generated rows vs independent reference script | `C: 100 generated rows match independent reference script` | pass |
| D | empty bank.csv edge case | `D: empty bank.csv -> everything onlyInternal` | pass |

## Environment note

This sandbox cannot pipe a grandchild process's stderr (`spawnSync` reports
EPERM and stderr arrives empty). Tests therefore redirect the CLI's stderr to
a file and read it back; the CLI itself writes `{code,message}` JSON to
stderr and exits non-zero correctly (verified manually).
