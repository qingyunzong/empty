# margin-call-scheduler

Risk-system margin-call scheduler (Node.js 22, standard library only, `node:test`).

A risk engine computes margin-call tasks from market snapshots. Tasks consume a
limited number of compute slots; accounts carry a priority, a liquidation line
and a deadline slot. Market corrections recompute only affected accounts
incrementally, and erroneous snapshots can be undone.

## Core mechanisms

- **Constrained resource allocation** — `src/scheduler.js` is a pure,
  deterministic scheduler. Tasks are ranked by priority (desc), then gap
  (desc), then liquidation distance (asc), then account id (asc), and placed
  into the earliest slot at or before their deadline with free capacity. When
  slots are full, a higher-ranked task preempts lower-ranked ones, which then
  report `NO_CAPACITY`.
- **Incremental correction** — `src/engine.js` keeps a per-symbol price book
  keyed by version and an equity cache per account. A tick recomputes only
  accounts holding that symbol (`stats.recomputes` tracks the work).
- **Snapshot undo / restore** — `undoTick(symbol, version)` removes the top
  version, restores the highest remaining valid version, and replays margin
  evaluation for affected accounts (`rolledBack` in the output).
- **Version discipline** — a tick with `version <= currentVersion` is rejected
  with `STALE_TICK`; a lower version never overwrites a higher one. Undo of a
  non-top or unknown version fails with `UNDO_GAP`.
- **Independent cross-check** — `src/full.js` replays the whole event log from
  scratch (no caching). The CLI compares both paths and reports
  `proof.fullRecomputeMatch`; the test suite cross-checks 500 random
  scenarios with n <= 8 accounts.

## Error codes

| Code              | Meaning                                             |
|-------------------|-----------------------------------------------------|
| `STALE_TICK`      | tick version <= current applied version             |
| `NO_CAPACITY`     | no free slot at or before the account's deadline    |
| `NEGATIVE_EQUITY` | equity < 0; account excluded from scheduling        |
| `UNDO_GAP`        | undo of a non-top or unknown snapshot version       |

## CLI

```
node cli.js <ticks.json> <accounts.json>
```

- `accounts.json`: `{ "accounts": [ { "id", "priority", "maintenanceLine", "liquidationLine", "deadlineSlot", "cash", "positions": { "SYM": qty }, "initialMarks": { "SYM": price } } ] }`
- `ticks.json`: `{ "slots": N, "slotCapacity": C, "events": [ { "type": "tick", "symbol", "version", "price" } | { "type": "undo", "symbol", "version" } ] }`

Output: `{ calls, rolledBack, errors, proof }` where `proof` contains the
deterministic `seed` (derived from the input hash), `scheduleHash`
(SHA-256 of the canonical schedule), `inputHash` and `fullRecomputeMatch`.
Exit code is 0 on success, 1 on bad input, 2 if the incremental result ever
diverges from the independent full recompute.

## Tests

```
node --test
```

Covers: out-of-order tick rejection, undo restoring the highest valid lower
version with call replay, `UNDO_GAP`, `NEGATIVE_EQUITY`, slot-full preemption
of low-gap by high-gap, deadline enforcement, ranking tie-breaks,
determinism, CLI pipeline, and a randomized incremental-vs-full-recompute
cross-check (n <= 8, 500 seeds).
