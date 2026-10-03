# clearsync

Deterministic clearing-channel scheduler for a settlement house: each day it
assigns cross-institution payment instructions to a finite number of clearing
channels (slots), respecting per-slot capacity, per-institution quotas,
deadlines and dependency chains — with priority preemption, atomic rollback,
replayable certificates, and incremental repair after undo.

Pure Node.js 22 standard library. No dependencies, no network, fully offline.

## Usage

```sh
node src/cli.js [input.json | -]   # reads a file, or stdin when omitted / "-"
node --test                        # full test suite
```

The CLI prints `{ "schedule", "certificates", "errors" }` as JSON on stdout
and exits with code **2** when `errors` is non-empty or the input is invalid,
**0** otherwise.

### Input

```json
{
  "config": {
    "slots": 2,
    "capacityPerSlot": 1,
    "quotas": { "X": 1 },
    "agingRate": 0,
    "exactThreshold": 12
  },
  "instructions": [
    {
      "id": "H",
      "institution": "I1",
      "amount": 10,
      "priority": 5,
      "deadlineSlot": 2,
      "arrivalSlot": 1,
      "dependencies": ["D"]
    }
  ],
  "undo": ["H"]
}
```

- `slots` (required): number of clearing slots, numbered `1..slots`.
- `capacityPerSlot` (default 1): max instructions per slot (mutual exclusion).
- `quotas` (default none): max confirmed instructions per institution.
- `agingRate` (default 0): starvation-aging bonus per waited slot.
- `exactThreshold` (default 12): instances up to this size get an exact
  cardinality-optimality pass.
- Instruction fields: `id`, `institution`, `amount`, `priority`,
  `deadlineSlot` (1..slots), `arrivalSlot` (0..slots, default 1),
  `dependencies` (ids that must be confirmed in strictly earlier slots).
- `undo`: ids of confirmed instructions to revoke after scheduling, applied
  in order, each followed by incremental repair.

## Core mechanisms

**Constraint scheduling.** Instructions are placed one at a time. The next
candidate is chosen by a total deterministic order:

1. effective score = `priority * 1e6 + (slots - arrivalSlot) * agingRate`, desc
2. global fairness: institution quota-usage ratio, asc
3. amount, desc
4. deadline slot, asc
5. id, lexicographic

Placement respects slot capacity, institution quota, arrival/deadline window,
and dependencies (all dependencies confirmed in strictly earlier slots).

**Starvation aging.** Long-waiting instructions accrue an aging bonus, so an
old low-priority instruction can overtake freshly arrived higher-priority
ones instead of starving (see `agingRate`).

**Preemption with atomic rollback.** A strictly higher-priority instruction
may evict a lower-priority occupant (never one of its own ancestors). The
victim and its confirmed transitive dependents are rolled back atomically —
the whole eviction + placement either commits (emitting `rollback` /
`preempt` / `assign` certificates) or does not happen — and rolled-back
instructions are retried.

**Replayable certificates.** Every mutation appends
`{ seq, op, instructionId, slot, reason, hash }` where `hash` is the SHA-256
of the canonical state (confirmed assignments + orphan set) after the
mutation. `replay(certificates)` (`src/certificates.js`) rebuilds the final
schedule from the empty state and verifies every hash.

**Undo + incremental repair.** `undo` revokes one confirmed instruction,
releases its quota, cascade-marks its confirmed dependents as `orphan`
(releasing their quota too), then repairs *incrementally*: only currently
unscheduled instructions whose dependencies are confirmed are retried against
the freed capacity. Unrelated confirmed assignments are never recomputed.
Undoing anything not currently confirmed is a `STALE_UNDO` error.

**Exact cardinality pass.** For `n <= exactThreshold`, a deterministic
branch-and-bound checks whether more instructions can be confirmed than the
greedy pass achieved; only a strictly larger feasible set is adopted (emitted
as `reoptimize` certificates), so heuristic choices are preserved on ties.
The test suite cross-checks this against an independent brute-force
enumeration of the optimal feasible set for `n <= 8` (150 random instances).

**Determinism.** Same input → same output, independent of instruction order
in the input file. All ties resolve by amount (desc), deadline (asc), id
(lexicographic). No clocks, no randomness, no I/O beyond the input.

## Output

- `schedule`: one entry per instruction with `status` ∈ `confirmed` |
  `unscheduled` | `orphan` | `revoked` and its `slot` (null unless
  confirmed). Confirmed entries sort by slot, then id.
- `certificates`: the full replayable mutation log.
- `errors`: `{ code, message, instructionId? }`. Codes: `CAPACITY`,
  `QUOTA`, `DEP_UNMET`, `CYCLE`, `MISSING_DEP`, `STALE_UNDO`,
  `INVALID_INPUT`.

## Verified output (real runs)

`node src/cli.js examples/preempt-undo.json` → exit 0:

```
schedule: D:confirmed@1  L:confirmed@2  H:revoked
certificates: 1:assign:L  2:assign:D  3:preempt:L  4:assign:H  5:undo:H  6:assign:L
errors: 0
```

(L is confirmed at slot 2, atomically rolled back when higher-priority H
preempts it, and recovered into the freed slot by incremental repair after H
is undone — without touching D@1.)

`node src/cli.js examples/quota-fairness.json` → exit 2:

```
schedule: x1:confirmed@1  y1:confirmed@2  x2:unscheduled
errors: QUOTA:x2
```

`node --test` (full suite, 17 tests across 3 files):

```
# tests 3
# pass 3
# fail 0
```

Covers: capacity-conflict failure, quota fairness and starvation aging,
preemption with atomic rollback and certificate replay, undo recovery after
preemption, orphan cascades with quota release, stale undo, cycle detection,
determinism under shuffled input, CLI exit codes (0/2), and the
brute-force optimality cross-check for n <= 8.

## Layout

- `src/validate.js` — input/schema validation, cycle tainting
- `src/scheduler.js` — greedy scheduling, fairness/aging, preemption, undo, repair
- `src/exact.js` — exact cardinality-improvement pass (small n)
- `src/certificates.js` — certificate emission, state hashing, replay
- `src/feasibility.js` — independent schedule checker (used by tests)
- `src/cli.js` — CLI entry point
- `test/` — node:test suites; `examples/` — runnable sample inputs
