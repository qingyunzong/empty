# flow-planner

Offline, single-machine flow-network planner for a disconnected workshop
(Node.js 22, standard library only). Orders, machine time slots and changeover
(link) constraints are modeled as a bipartite flow network:

```
source --demand--> order --link capacity--> slot --capacity x machine factor--> sink
```

Corrections (rush order insert, cancel, machine slowdown) are applied
incrementally as an uncommitted batch; every query recomputes the max flow and
emits the max deliverable value plus a bottleneck certificate (min cut).

## Commands (JSONL, one object per line)

| Command | Fields | Effect |
| --- | --- | --- |
| `add_order` | `id`, `demand` (>0), `window` `[start,end]` (optional) | add order |
| `add_slot` | `id`, `machine`, `start`, `end`, `capacity` (>0) | add machine slot (slots on one machine must not overlap) |
| `link` | `order`, `slot`, `capacity` (optional, default infinite) | allow production; slot must overlap the order window |
| `slow` | `machine`, `factor` in (0,1] | multiply all slot capacities of the machine |
| `cancel` | `id` | remove an order or slot and its links |
| `commit` | — | checkpoint pending corrections; clears the undo stack |
| `undo` | — | revert the newest uncommitted correction |
| `flow` | — | `{value, assignments, bottleneck_cut}` |
| `verify` | — | checks conservation, capacity, time windows, cut equality |

All mutations are undoable corrections until committed. `commit` with no
pending corrections is a `CONFLICT`; `undo` with nothing uncommitted is
`UNDO_EMPTY`; invalid arguments are `INVALID_INPUT`. Committed plans can never
be lost by an undo sequence.

Assignments are deterministically tie-broken by order id, then slot start
time, then slot id.

## Usage

```sh
node cli.js commands.jsonl   # or: cat commands.jsonl | node cli.js
node --test                  # run the test suite
```

Library API: `new Planner().execute(cmd)` (see `src/planner.js`).
