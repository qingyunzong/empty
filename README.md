# obs-scheduler

Observatory night scheduler for Node.js 22 (standard library only, tests via `node:test`).

## Model

Event stream (`events.jsonl`), one JSON object per line. Every event carries a
Lamport `clock` and a `node` id; concurrent history is merged deterministically
by `(clock, nodeID, targetID)`.

| event | fields | meaning |
| --- | --- | --- |
| `plan` | `target`, `pi`, `window:[s,e]`, `value`, `switch`, `quota?`, `cloud?` | register a target; `quota` caps the PI's total exposure |
| `observe` | `target`, `obs`, `window:[s,e]` | confirmed observation (immutable, must not overlap others) |
| `correct` | `target`, `window?`, `closed?`, `cloud?` | cloud correction: may only shorten/close a window; `cloud:"unknown"` keeps the target **pending** (pending != unsatisfiable) |
| `revoke` | `obs` | revoke a confirmed observation (unknown obs -> exit 3) |
| `checkpoint` | — | persist a snapshot for crash recovery |

## Scheduling

- Interval scheduling with switch costs: consecutive activities need
  `end_i + switch_{i+1} <= start_{i+1}`; confirmed observations are fixed blocks.
- Objective (lexicographic): maximize total science value → minimize the max
  PI exposure deficit (fairness) → smallest sorted target-id list (ties break
  by target ID).
- Corrections that invalidate a scheduled target cascade a reschedule;
  confirmed observations never move. Preemption happens only at correction
  boundaries and records `interrupted`/`preempted` evidence.
- Output: executable `sequence`, `skipped` (with reasons), `pending`,
  `evidence`, and a sha256 `certificate` over the canonical result + event log.

## CLI

```
node bin/obs-sched.js --events events.jsonl [--out result.json] \
  [--checkpoint-file checkpoint.json] [--recover checkpoint.json]
```

Exit codes: `0` ok, `2` usage/IO, `3` domain error (window overlap,
negative duration, revoke of unknown observation, window expansion, ...).

## Tests

```
node --test test/*.test.js
```

Covers: solver vs brute-force enumeration (n<=10), cascade reschedule with
confirmed observations unchanged, target-ID tie-breaks, checkpoint crash
recovery certificate equality, pending cloud handling, preemption evidence,
and all exit-3 error paths.
