# bounded-queue-network-sim

Tick-based service-desk network simulation in TypeScript using only Node.js
built-in modules (no runtime or dev dependencies; the globally available
`tsc` compiles the sources).

## Model

- Each desk （服务台） has a bounded input queue, one server slot, and a
  **bounded output queue**.
- When a finished customer cannot unload because the output queue is full
  (ultimately because downstream is full), the desk **keeps its service slot
  occupied** (blocking-after-service); no new service starts on that desk.
- Same-tick phase order: **complete → move → start**
  (先完成再移动再开工):
  1. `complete`: count down service, unload finished customers into the
     bounded output queue (or mark the server blocked).
  2. `move`: sinks drain, edges transfer while downstream input capacity
     allows, sources inject.
  3. `start`: idle servers take the next waiting customer.
- **Circular wait**: `detectCircularWait()` builds the wait-for graph
  (desk A waits on desk B when A holds customers for B while B's input is
  full) and reports evidence: the cycle plus, per edge, the waiting customer
  ids and downstream occupancy/capacity. A fully wedged cycle is absorbing.
- **Snapshot/replay**: `snapshot()` / `Network.fromSnapshot()` capture and
  restore full state; `observe()` extracts per-desk customer counts and all
  service-time records so a replayed run can be cross-checked tick by tick
  against the original.

## Commands

- `npm test` — compile with `tsc` and run the `node:test` suite.
- `npm run demo` — print a trace, circular-wait evidence, and a wedged
  cycle that never recovers.

## Actual test results

Recorded on Node v22.22.1, tsc 7.0.2 (`npm test`):

```
ok 1 - same-tick order: complete -> move -> start
ok 2 - downstream full: upstream keeps its service slot occupied
ok 3 - circular wait emerges under load and is reported with evidence
ok 4 - a fully wedged cycle is absorbing: evidence persists every tick
ok 5 - no false positive: open chain never reports circular wait
ok 6 - snapshot replay matches the per-tick model: counts and service times
ok 7 - customer conservation holds at every tick
# tests 7
# pass 7
# fail 0
```
