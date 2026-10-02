# RESULTS

Recorded by actually running the test suite in this workspace.

- Date: 2026-10-03
- Runtime: Node.js v22.22.1 (linux x64), standard library only
- Command: `node --test`

## Summary (TAP)

```
ok 1 - test/acceptance1-late-metro.test.js
ok 2 - test/acceptance2-retract-cascade.test.js
ok 3 - test/acceptance3-enumeration.test.js
ok 4 - test/acceptance4-ties.test.js
ok 5 - test/cli.test.js
# tests 5
# pass 5
# fail 0
# duration_ms 7252.426829
```

## Per-file (spec reporter)

```
✔ test/acceptance1-late-metro.test.js   — late metro rewrites priority, re-plan to better optimum
✔ test/acceptance2-retract-cascade.test.js — tool-window retract cascades migration; metro retract releases locked budget
✔ test/acceptance3-enumeration.test.js  — 300 randomized instances (<=6 carriers) vs independent brute force
✔ test/acceptance4-ties.test.js         — same-event/same-score ties enumerate all optima, due/lot/carrier order
✔ test/cli.test.js                      — 4 output files, CAP_INVALID, pending metro, usage errors
ℹ pass 5
ℹ fail 0
```

## Acceptance mapping

1. **Late metrology triggers a better re-plan** — `test/acceptance1-late-metro.test.js`:
   metro for lot `L2` (score 99) arrives behind the watermark; it is logged in
   `late.log`, a `METRO_LATE_REWRITE` entry appears in `rework.jsonl`, and the
   single capacity slot migrates `C1 -> C2` (objective 10 -> 99).
2. **Tool-window retraction cascades migration** — `test/acceptance2-retract-cascade.test.js`:
   retracting `T1` migrates `C1: T1->T2` and bumps `C2: T2->null`;
   `budget.json` never reports negative remaining. A second case shows metro
   retraction releasing locked budget (`C1` bumped, `C3` dispatched).
3. **Enumeration cross-check (<=6 carriers)** — `test/acceptance3-enumeration.test.js`:
   300 seeded random instances; solver objective, full tied-solution set, and
   per-window budget feasibility all match an independent brute-force
   enumeration.
4. **Ties are never dropped** — `test/acceptance4-ties.test.js`: 2 carriers /
   1 slot yields both optima; 3 carriers / 2 slots yields all C(3,2)=3 optima;
   assignments are ordered by `due`, `lot`, `carrier`; the engine keeps all
   tied solutions in `plan.json`.

## Notes

- CLI tests invoke `run()` from `src/cli.js` in-process (the same code path
  `bin/dispatch.js` calls) because this sandbox intermittently returns EPERM
  for `child_process.spawnSync`. The binary itself was verified directly:
  `node bin/dispatch.js solve --in <dir> --out <dir>` exits 0 and writes all
  four output files; a `cap:-1` input exits 1 with `CAP_INVALID` on stderr.
