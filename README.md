# asrs-wave-planner

Offline wave planning for automated storage/retrieval shuttles. Node.js 22,
standard library only, `node:test` for the test suite. No network access
required.

Three plan layers — **wave → task → move** — with a hard battery budget,
hierarchical rollback (compensation for executed moves, reuse for unstarted
ones), and causal aisle-exclusion for concurrent shuttles.

## CLI

```
node src/cli.js wave     [--file F] [--budget N] [--wave ID] [--cap N]
node src/cli.js rollback [--file F] [--level wave|task|move --id X]
node src/cli.js verify   [--file F]
```

Input is JSONL on stdin (or `--file`), output is JSONL on stdout. Exit codes:

| code | meaning |
|------|---------|
| 0    | success |
| 1    | `verify` found invariant violations |
| 2    | usage / parse / unknown entity |
| 17   | battery budget insufficient (body carries `minimalReduction`) |
| 18   | rollback skips a hierarchy level |

### `wave`

Input lines:

```json
{"type":"config","wave":"W1","budget":100,"shuttles":[{"id":"S1","home":"A1:0","speed":1,"energyPerUnit":1}]}
{"type":"aisle","id":"A9","state":"unknown"}
{"type":"task","id":"T1","moves":[{"id":"M1","from":"A1:0","to":"A1:4","aisles":["A1"],"energy":4,"duration":4}]}
{"type":"reusable","move":{"id":"M7","from":"A2:1","to":"A2:4","aisles":["A2"],"energy":3,"duration":3}}
```

* Locations are `"AISLE:SLOT"`. `aisles`/`energy`/`duration` on moves are
  optional and derived deterministically when omitted.
* The planner enumerates every ordered task→shuttle partition (with a
  deterministic greedy fallback past `--cap` candidates), inserts
  repositioning moves, and schedules with aisle exclusion. The budget is a
  **hard constraint** per shuttle per wave. Among feasible plans the optimum
  is chosen by the lexicographic tuple **(completion time, energy, path
  key)** — ties are therefore always resolved the same way.
* `reusable` lines re-attach moves returned by an earlier rollback; a
  matching planned move inherits the pooled energy/duration and is marked
  `reusedFrom`.
* Aisle state lines are accepted for context; `unknown` state never blocks.

On budget shortfall the command exits 17 and prints the **minimal reduction
set** (minimum cardinality, then lexicographically smallest id list) whose
removal makes the wave plannable:

```json
{"type":"error","code":"BUDGET_INSUFFICIENT","budget":4,"minimalReduction":["T2"]}
```

### `rollback`

Reads a journal (the output of `wave` plus `execute` records) and a rollback
request (last `{"type":"rollback","level":...,"id":...}` line or
`--level/--id`). The journal is append-only: the input is echoed and the
rollback records are appended.

* Rollback must be contiguous from the top of the commit stack: every active
  entity committed after the target must be its descendant. Anything else is
  a level violation → exit 18.
* Cascades wave → tasks → moves. **Executed** moves are reversed by
  **compensation moves** (`kind:"compensation"`, swapped from/to, recorded
  energy) — history is never erased. **Unstarted** moves become `reusable`
  and can be fed back into a later `wave` run.

### `verify`

Checks a journal and prints one `check` line per invariant plus `release`
lines and a `summary`:

* `hierarchy` — referential integrity of waves/tasks/moves/executions.
* `budget` — per-wave per-shuttle planned energy ≤ budget.
* `aisle-exclusion` — no overlapping occupancy per aisle; an in-flight move
  makes any later occupant unprovable → violation.
* `causal-order` — shuttles are never double-booked and executions follow
  the planned causal sequence.
* `compensation-integrity` — rolled-back waves fully cascaded; every
  compensated move has exactly one compensation.
* `pending-conditions` — every pending move carries resolvable unblock
  conditions (no cycles, real in-flight blockers only; unknown aisle state
  is never a blocker).

`release` lines implement the causal release rule: a planned move is
`released` only when its causal predecessor completed and no aisle it needs
is held by an in-flight move; otherwise it stays `pending` with `blockedBy`
conditions that say exactly what must `complete` to lift them.

## Tests

```
node --test
```

Covers the four acceptance points: exhaustive-optimum comparison including
ties, energy-non-increasing replay after wave rollback, causal-only release
under concurrent aisle occupation, and feasibility at exactly-bounded
battery. Real captured output lives in `docs/acceptance-run.txt`.
