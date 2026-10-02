# flowshop-planner

Offline, single-machine CLI + library for a job-shop planner that models
orders, machine time slots and changeover constraints as a flow network.
Pure Node.js 22 standard library — no dependencies, no network.

## Model

- `source -> order` edges carry the order demand.
- `order -> slot` edges are created by `link` (optional per-link capacity).
- `slot -> sink` edges carry the slot capacity multiplied by the machine's
  slowdown factor (`slow(machine, factor)`).
- Max flow = maximum deliverable quantity. The bottleneck certificate is the
  min cut, reported as the source-side reachable set (`bottleneck_cut`):
  `orders`/`slots` still reachable from the source in the residual graph.
  Cut capacity = demands of unreachable orders + effective capacities of
  reachable slots, and always equals the flow value (checked by `verify`).

Corrections (`add_order`, `add_slot`, `link`, `slow`, `cancel`) are journaled.
`undo` reverts the most recent uncommitted correction (LIFO); `commit`
confirms all pending corrections and empties the journal, so committed plans
can never be lost by an undo sequence. Recomputations are full recomputes on
the current state, so every `flow` reflects all uncommitted corrections.

## Commands (JSONL, one per line)

```json
{"cmd":"add_order","id":"o1","demand":10,"release":0,"due":100}
{"cmd":"add_slot","id":"s1","machine":"M1","start":0,"end":10,"capacity":8}
{"cmd":"link","order":"o1","slot":"s1","capacity":5}
{"cmd":"slow","machine":"M1","factor":0.5}
{"cmd":"cancel","id":"o1"}
{"cmd":"commit"}
{"cmd":"undo"}
{"cmd":"flow"}
{"cmd":"verify"}
```

- `release`/`due` default to `0`/`+inf`; a link is rejected unless the slot
  window lies inside the order window.
- Slots on the same machine may not overlap in time.
- `flow` returns `{"status":"OK","value":...,"assignments":[...],"bottleneck_cut":{...}}`
  with assignments sorted by order id, then slot start time. The flow itself
  is deterministic: ties are broken toward earlier order ids and earlier
  slot start times.
- `verify` re-checks the last `flow` result: flow conservation, capacities,
  time windows, and cut value == flow value.
- Errors: `INVALID_INPUT` (bad numbers, negative capacity, overlapping
  windows, unknown references, malformed JSON), `CONFLICT` (duplicates,
  commit with nothing pending), `UNDO_EMPTY` (undo with nothing uncommitted).

## Usage

```sh
node src/cli.js                 # read JSONL commands from stdin
node src/cli.js commands.jsonl  # or from a file
npm test                        # node --test
```

Library: `import { Planner } from './src/planner.js'`, then
`planner.execute(cmd)` per command, or `import { runCli } from './src/cli.js'`.

Scale: orders <= 150, slots <= 300 recompute in well under a second.
