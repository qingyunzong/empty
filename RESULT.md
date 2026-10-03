# RESULT

- Date (UTC): 2026-10-03T17:58Z
- Runtime: Node.js v22.22.1 (standard library only, `node:test`)
- Command: `node --test`

## Summary

```
# tests 4 (files) / 18 (subtests)
# pass 18
# fail 0
```

`node --test` (TAP summary):

```
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms ~2000-3600
```

## Subtests (all ok)

test/acceptance.test.js — 6/6
- ok A: three-shift rotation crossing midnight
- ok B: material locks restored after supervisor revokes freeze
- ok B2: non-supervisor cannot revoke a freeze
- ok C: concurrent same-timestamp events use deterministic tie-break
- ok D: 100 random events, incremental state matches brute-force replay at every prefix
- ok D2: parseEvents accepts the random stream (monotonic ts)

test/gate.test.js — 7/7
- ok permission inherits productLine -> workCenter -> workOrder
- ok compensation event generated when a lock-consuming release is overridden
- ok reschedule moves an order to another shift
- ok capability-insufficient orders are unscheduled and reported as breach
- ok material-insufficient release is flagged and not releasable
- ok counterexample: minimal sequence flipping W1 from releasable to frozen
- ok counterexample: reports when order is not releasable in base state

test/cli.test.js — 5/5
- ok exit 5 on time regression
- ok exit 6 on negative capability
- ok exit 7 on unknown material
- ok run writes schedule.out.json, breach.json and audit.jsonl; replay from arbitrary event matches
- ok counterexample CLI emits minimal freeze sequence

## Notes

- CLI exit codes verified against a real process: time regression -> exit 5,
  negative capability -> exit 6, unknown material -> exit 7, success -> exit 0.
- Acceptance D replays every prefix (1..100) of a seeded random event stream from
  scratch and compares SHA-256 state hashes against the incremental run: all equal.
- The sandbox blocks `spawnSync` (EPERM), so CLI tests invoke `runMain()` in-process;
  real-process exit codes were verified separately via shell (`echo $?`).
