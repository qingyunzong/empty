# lab-prep-recovery

Crash-recoverable workflow engine for lab sample preparation (weigh / dilute /
mix / incubate). Node.js 22, standard library only, tests via `node:test`.
Single machine, fully offline.

## CLI

```
node cli.js run     --protocol p.json --journal run.jsonl [--state dir] [--result f]
                    [--crash-at before-effect|after-effect|during-checkpoint:<step>]
                    [--abort-step id] [--now ms]
node cli.js recover --journal run.jsonl [--protocol p.json] [--state dir]
                    [--report f] [--result f] [--now ms]
node cli.js abort   --journal run.jsonl --step id [--state dir] [--reason r]
```

Defaults: state dir is `state/` next to the journal; outputs are `result.json`
and `recovery_report.json` next to the journal. `run` snapshots the protocol
into `<state>/protocol.json` so `recover` works without `--protocol`.

Exit codes: `0` ok · `1` usage/io · `2` consistency error (missing product,
timeout-but-joined, abort of a completed join) · `75` injected crash.

## Journal model

`run.jsonl` is an append-only JSONL log. Each step execution writes three
segments:

1. `intent` — step scheduled (attempt, requires, produces, ts)
2. `effect` — products materialized in the state dir
3. `checkpoint` — step marked done

Crash-injection points are fixed: **before the effect write**, **after the
effect write**, and **during the checkpoint write** (torn partial line).
Recovery truncates a torn tail record, then per step:

- `effect` without `checkpoint` → effect is durable, **never re-executed**;
  only the checkpoint is repaired.
- `intent` without `effect` → half-done step: if `now - intent.ts > timeout`
  it is **discarded** (`discard` record + compensation chain), otherwise it is
  **continued** (re-executed idempotently with a new attempt).

Branch steps run in any ready order; a join step executes only when **all**
upstream effects are visible (journal effect records + product files present).

## Abort & compensation

`abort` appends an `abort` record plus a compensation chain:

- products of completed upstream steps are **marked consumed** (samples are
  unrecoverable): `compensation` records with `action: mark-consumed` plus
  `<product>.consumed` marker files in the state dir;
- unstarted downstream steps are **released**: `action: release`.

Aborting an already-completed join exits with code 2 (`ABORT_COMPLETED`).

## Outputs

- `result.json` — run status (`completed|aborted|failed|incomplete`), per-step
  status/attempts, products, consumed list, compensation records.
- `recovery_report.json` — torn records truncated, repaired checkpoints,
  continued steps, discarded steps (with reason/timeout), preserved effects,
  compensations. The journal itself remains the audit trail.

## Acceptance mapping

| # | Requirement | Test |
|---|-------------|------|
| 1 | Crash at 3 fault points, recovery equals reference | `test/crash_recovery.test.js` (3 tests) |
| 2 | Parallel branch abort → join never triggers | `test/abort.test.js` |
| 3 | Timed-out incubation discarded, auditable compensation | `test/timeout.test.js` |
| 4 | Enumerate crash positions for 5-step protocol (3×5) | `test/enumerate.test.js` (15 tests) |
| — | Error contract (missing product, timeout-joined, abort completed join) | `test/errors.test.js`, `test/abort.test.js` |

## Test results (real run)

`node --test` on Node v22.22.1:

```
# tests 6     (files)
# pass 6
# fail 0
```

24 subtests in total, all passing: crash_recovery 3, abort 2, timeout 1,
enumerate 15, errors 3.
