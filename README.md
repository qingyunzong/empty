# toollife

Offline replay of machining tool-life events. Node.js 22, standard library only,
tests via `node:test`. No network, no dependencies.

Tools are寿命-managed by cutting length. The system replays measurements, tool
changes and compensation events from a JSONL causal log, enforces layered
lifetime budgets, and prevents machining past end-of-life.

## Event log format

One JSON event per line (`#` lines and blank lines are ignored). Every event has
`id` (unique string) and `causes` (array of event ids it causally follows;
defaults to `[]`). The log may be in any order; replay uses a deterministic
topological order (smallest id first among ready events).

| type | fields | meaning |
| --- | --- | --- |
| `budget` | `level: order\|operation\|segment`, `order`[, `op`[, `seg`]], `limit` | set a layered lifetime budget (length units) |
| `cut` | `tool`, `order`, `op`, `seg`, `length` | machining consumes tool life at all three layers |
| `measure` | `tool`, `order`, `op`, `seg`, `length` | offline measurement of consumed length |
| `transition` | `tool`, `to: idle\|cutting\|worn\|locked` | explicit state request, causally guarded |
| `compensate` | `tool`, `target` | revoke a false `measure` event |

## Semantics

- **Layered budget** — every `cut`/`measure` adds `length` to the order,
  operation and segment buckets (`O`, `O/P`, `O/P/S`). Usage `> limit` at any
  layer locks the tool; replay reports the *earliest* overspend point (event id
  + all exceeded layers). Boundary is exact: `limit-1` → `cutting`,
  `limit` → `worn`, `limit+1` → `locked`.
- **State machine** — `idle → cutting → worn → locked`. Derived from usage
  (0 / within / at / over budget) plus explicit `transition` events. Legal
  explicit moves: `idle→cutting|locked`, `cutting→idle|worn|locked`,
  `worn→locked`. Everything else (including anything out of `locked`) is an
  illegal transition. A `transition` must causally follow the tool's current
  state token (causal guard).
- **Conflict** — usage events (`cut`/`measure`) on the same tool must be
  totally ordered by happens-before. A causally incomparable pair is a
  conflict; replay never picks an arbitrary order. The error carries both ids.
- **Compensation / undo** — a `compensate` event (or the `undo` command)
  revokes a false measurement and rolls back every budget layer by exactly its
  length. Locked facts are immutable: the lock record and any scrap (cuts
  performed while locked) are never rewritten; undo only produces a recovery
  path (`append_compensation → rollback* → locked_fact_retained →
  replace_tool → requalify_tool`, plus a non-reversible `scrap_verdict`).

## CLI

```
toollife replay <log.jsonl|->            replay events
toollife undo <log.jsonl|-> <measureId>  plan compensation of a false measurement
toollife budget <log.jsonl|->            layered budget usage report
toollife audit <log.jsonl|->             integrity check (lists all conflicts)
```

Results are JSON on stdout; errors are JSON on stderr.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | ok |
| 2 | validation / usage error |
| 12 | budget exceeded (report names the earliest overspend point) |
| 13 | illegal state transition (incl. causal-guard failure) |
| 14 | conflict — concurrent measure/cut, both ids reported |

## Tests

```
node --test
```

Covers: budget boundary ±1 determinism, layered rollback consistency after
undo, happens-before vs. brute-force enumeration of all linear extensions for
histories of ≤7 events, scrap-mark immutability after lock, and CLI exit codes.
Last full run is saved in `test-output.txt`.
