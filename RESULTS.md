# RESULTS

Recorded by actually running the commands below on 2026-10-03 (Node v22.22.1,
Linux x86_64). Exit codes are the real observed values.

## Test suite

Command: `node --test`

- Exit code: **0**
- Summary: 4 test files, 4 passed, 0 failed (duration ~18.6 s; the CLI test
  file spawns `node` subprocesses, which dominates the runtime).
- Subtest counts (via `node <file>` per file, all exit code 0):
  - `test/relalg.test.js`: 10 passed / 0 failed
  - `test/engine.test.js`: 9 passed / 0 failed
  - `test/cert.test.js`: 6 passed / 0 failed
  - `test/cli.test.js`: 7 passed / 0 failed
  - Total: 32 subtests, 32 passed, 0 failed.

## Acceptance mapping

- A (normal run, NULL fee, duplicate reversal): `test/engine.test.js` "A:
  netting with NULL fee and duplicate cancel"; `test/cli.test.js` "CLI
  settle: normal run with NULL fee and duplicate reversal".
- B (incremental == independent full recompute): `test/engine.test.js` "B:
  incremental ledger matches independent full recompute after each event"
  (compares `Ledger` against `settleFull` after every event, including
  duplicate and unknown cancels).
- C (tamper one row → cert verification fails): `test/cert.test.js` "C:
  tampered row fails verification"; `test/cli.test.js` "CLI verify: ok on
  untouched output, fails after tampering one row" (exit != 0,
  `E_CERT_MISMATCH`).
- D (empty group / all-NULL boundaries): `test/engine.test.js` "D: empty
  inputs produce zero rows", "D: all-NULL fee group has fee_total NULL, not
  0", "D: group emptied by cancels disappears entirely"; `test/cli.test.js`
  "CLI: empty inputs produce empty result and verifiable cert".

## Performance smoke (50k rows)

Command: `node bin/settle.js --in /tmp/perf --out /tmp/perf/out.json --cert /tmp/perf/cert.json`
with 50,000 trades + 5,000 cancel events (generated synthetically).

- Exit code: **0**; 4,500 result groups; `settle verify` also exit 0.
- Timing: real 4.1 s, user 1.5 s, sys 0.3 s (includes Node startup).

## Notes

- No claim is made beyond the runs above; all results were produced by
  executing the listed commands in this workspace.
