# obs-scheduler

Observatory night-time telescope target scheduler. Node.js 22, standard library
only (`node:test` for tests).

## Usage

```sh
node bin/obs.js run <events.jsonl> [--state DIR]   # process stream, print schedule + certificate
node bin/obs.js recover [--state DIR] [--events F] # crash recovery from latest checkpoint
```

`run` prints a JSON document with the executable sequence (`schedule`),
confirmed observations (`fixed`), `skipped` reasons, `pending` targets,
preemption evidence (`preemptions`), per-PI `exposure`/`deficits`, and a
deterministic `certificate` (sha256 over the canonical JSON of all fields).
`checkpoint` events persist the merged event prefix + certificate into the
state dir; `recover` replays the checkpoint, verifies its certificate
(exit 4 on mismatch), and optionally continues the remaining stream —
the resulting certificate is identical to a fresh full run.

## Event model (one JSON object per line)

- `plan` — `{type, target, pi?, duration, value?, switch?, windows?: [[s,e]...], quota?, clock?, node?}`
  Declares a target. `switch` is the device setup time required before this
  target; `quota` sets the PI's exposure entitlement.
- `observe` — `{type, id, target, start, end, value?, clock?, node?}`
  Confirms an actual observation. Confirmed observations are immutable, count
  toward PI exposure, and fulfill their target.
- `correct` — `{type, target, windows?, cloud?, clock?, node?}`
  Cloud correction: replaces the target's known windows (shorten, or `[]` to
  close) and/or sets cloud cover. `cloud: "unknown"` keeps the target
  **pending** — never treated as unsatisfiable.
- `revoke` — `{type, id, clock?, node?}` — revokes a confirmed observation.
- `checkpoint` — `{type, id?, clock?, node?}` — persists recovery state.

Concurrent history is merged by logical clock; conflicts are ordered by
`(clock, nodeID, targetID)`, then arrival order.

## Scheduling core

Exact DP over `(remaining-target mask, segment, time)` for n <= 20
(deterministic greedy fallback beyond). Objective is lexicographic:

1. maximize total science value;
2. fairness: minimize the maximum PI quota deficit
   `max(0, quota - accruedExposure)`, then the sum of deficits;
3. tie-break by lexicographically smallest sorted target-id list.

Preemption happens only at observation boundaries: when a correction or other
mutation drops/moves a previously scheduled (unconfirmed) observation,
interruption evidence (planned interval, boundary, cause, replacements) is
recorded. Confirmed observations are never preempted.

## Errors (exit code 3)

- overlapping windows within a `plan`/`correct` event;
- negative duration (`plan.duration < 0`, window `end < start`, `observe.end < start`);
- `revoke` of an unknown observation id;
- malformed events (unknown type, missing fields, invalid JSON line).

## Tests

```sh
node --test test/*.test.js
```
