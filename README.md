# tool-life-replay

Offline replayer for machining tool-life events. Node.js 22, standard library
only, tested with `node:test`. No network, no dependencies.

Tools are tracked by cutting length. The system replays measurements, cuts,
tool changes and compensations from an append-only event log, enforces layered
life budgets (order → operation → segment, plus per-tool life) and refuses
over-life machining by locking the tool.

## Event model

Each line of the log (JSONL, or a JSON array) is one event:

```json
{"id":"e1","type":"measure","tool":"T1","order":"O1","op":"OP1","seg":"S1","length":40,"deps":[]}
{"id":"e2","type":"cut","tool":"T1","order":"O1","op":"OP1","seg":"S1","length":20,"deps":["e1"]}
{"id":"e3","type":"tool_change","tool":"T1","deps":["e2"]}
{"id":"e4","type":"compensate","target":"e1","deps":["e1","e2"]}
```

- `measure` / `cut`: record `length` of cutting for a tool on
  order/operation/segment. `cut` additionally marks production: a cut that
  exceeds the tool life marks the part as **scrap**.
- `tool_change`: resets a non-locked tool to `idle` with zero consumption.
- `compensate`: revokes a previous `measure`. It must causally depend on its
  target. If the target is a locked fact, nothing is rewritten; a recovery
  path is generated instead.
- `deps`: causal predecessors. Missing dependencies or cycles are rejected by
  the causal guard as illegal transitions.

## State machine

```
idle --measure|cut--> cutting --measure|cut--> cutting
cutting (used == life) --> worn
worn --measure|cut--> locked        (cut also marks scrap)
any  --tool_change--> idle          (except locked)
locked: terminal; every further transition is illegal
```

Consumption exactly at budget is allowed (`worn`); one unit above locks the
tool and reports the earliest overspend point.

## Budgets

```json
{
  "tools":      { "T1": 100 },
  "orders":     { "O1": 1000 },
  "operations": { "O1/OP1": 500 },
  "segments":   { "O1/OP1/S1": 200 }
}
```

Segment consumption rolls up into its operation, and operations into their
order. Exceeding any layer locks the tool and the first lock in causal replay
order is reported as the earliest overspend point.

## Concurrency

Replay order is the canonical topological order (ties broken by event id),
but if two concurrent events interact (same tool or shared budget layer) and
their relative order changes the outcome, the log is rejected as a conflict
with both event ids instead of picking an arbitrary order. For logs of up to
8 events the check enumerates all linear extensions; larger logs use a
pairwise swap check.

## CLI

```
node src/cli.js replay <log> [--config file]
node src/cli.js undo <log> --target <measureId> [--config file] [--append]
node src/cli.js budget <log> [--config file]
node src/cli.js audit <log> [--config file]
```

`<log>` is a JSONL file or JSON array; `-` reads stdin. Exit codes:

| code | meaning                                  |
| ---- | ---------------------------------------- |
| 0    | ok                                       |
| 2    | usage / malformed input                  |
| 12   | budget exceeded (over-life machining)    |
| 13   | illegal transition / causal guard reject |
| 14   | conflict: incomparable concurrent events |

## Library

- `analyze(events, config)` → `{ outcome, conflict, error, canonical }`
- `simulate(ordered, ctx, config)` → deterministic outcome for one ordering
- `enumerateOutcomes(events, config)` → set of outcome signatures over all
  linear extensions
- `buildCompensation(events, targetId)` → compensation event depending on the
  target and all current leaves

## Tests

```
node --test
```

Covers: budget boundary ±1 determinism, layered rollback consistency after
undo, conflict detection cross-checked against brute-force enumeration of all
histories for logs of ≤7 events, and immutability of scrap marks after lock.
