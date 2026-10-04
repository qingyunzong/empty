# Test results

Command: `node --test` (Node v22.22.1, run 2026-10-05, Asia/Shanghai)

```
# tests 6
# suites 0
# pass 6
# fail 0
# duration_ms 15428.765598
```

Per-file (`--test-reporter=spec`):

```
✔ test/cli.test.js (21561.53086ms)
✔ test/fault.test.js (1457.906255ms)
✔ test/helpers.js (625.973697ms)
✔ test/planner.test.js (1721.744992ms)
✔ test/solver.test.js (2631.944834ms)
✔ test/sync.test.js (1637.792481ms)
```

Individual assertions (TAP):

- test/solver.test.js
  - ok — budget boundary: exact capacity feasible, one minute less infeasible
  - ok — budget boundary: mold life exactly at demand feasible, one shot less infeasible
  - ok — tie-break: equal-cost optima resolve to the same canonical plan
  - ok — enumeration cross-check: solver matches brute force for n<=9 (n=1..9 × 8 seeds)
- test/planner.test.js
  - ok — incremental recompute: insert only computes new cache keys
  - ok — budget boundary via planner: feasible=false keeps last feasible certificate
  - ok — pending jobs are excluded, never treated as unsatisfiable
  - ok — hierarchical rollback: locked maintenance survives batch rollback
  - ok — rollback out of bounds raises ROLLBACK (exit code 6)
- test/fault.test.js
  - ok — fault point 1: torn journal append is truncated and valid prefix replayed
  - ok — fault point 2: orphan plan.tmp is discarded, committed plan kept
  - ok — fault point 3: uncommitted budget manifest rolled back, committed budget kept
  - ok — fault point 3b: leftover budget.tmp and uncommitted budget.json are discarded
- test/sync.test.js
  - ok — bidirectional delta exchange: version vectors merge, plans converge
  - ok — resource over-allocation after merge becomes pending, not infeasible
  - ok — concurrent conflicting assigns resolve by version vector tie-break
- test/cli.test.js
  - ok 1 — no arguments: usage error, exit 2, stderr JSON
  - ok 2 — happy path: apply ops, plan feasible, verify ok
  - ok 3 — budget shortfall: exit 3, stderr JSON, certificate preserved in stdout
  - ok 4 — rollback out of bounds: exit 6, stderr JSON ROLLBACK
  - ok 5 — rollback removes last batch and stays verifiable
  - ok 6 — verify detects tampered plan: exit 2 CORRUPT
  - ok 7 — sync command: two terminals converge, pending reported

Environment note: this sandbox blocks `spawnSync` (EPERM) and piped stdio of
spawned children, so CLI tests spawn `bin/mold-plan.js` asynchronously with
stdout/stderr redirected to temp files. The CLI itself is unaffected.
