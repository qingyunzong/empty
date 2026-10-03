# Line-Side Buffer Discrete-Event Simulation

Offline verification for electronics assembly line-side buffers: given
arrivals, station takt times and capacities, decide whether any station
starves or any buffer overflows, and report the earliest time at which the
violation necessarily occurs. Node.js 22, standard library only, `node:test`.

## Model

- Flow line: `stations[0..n-1]` with `{cap, proc}`, `buffers[0..n-2]` with
  `{cap}` between consecutive stations (`buffers.length === stations.length - 1`).
- Jobs arrive at station 0, are processed, handed downstream directly when the
  next station has free capacity, otherwise queued in the intermediate buffer.
- Events are ordered by `(time, rank, seq)`; completions rank before arrivals
  at the same timestamp, and `seq` (insertion order) is the stable final
  tie-break, so same-time arrivals are processed in generation order.
- Policies: `fifo` (buffer head) and `priority` (highest priority, ties broken
  stably by arrival `seq`).

## Violations (`firstViolation`)

- `station-overflow` — a job reaches a station with no free capacity.
- `buffer-overflow` — a completed job finds the downstream station busy and
  the intermediate buffer full.
- `starvation` — a downstream station that has already produced sits idle
  with free capacity while its upstream buffer is empty and work is still
  pending; checked only after all events of a timestamp settle.

## Status semantics

- `SAFE` — the event queue drained completely within the horizon; every
  reachable state in the finite time bound was visited and checked. A
  coverage certificate is attached (`statesVisited`, `distinctStates`,
  `queueDrained`, sha-256 `digest` of the visited-state sequence).
- `VIOLATION` — `firstViolation` carries the earliest violating event.
- `UNKNOWN` — the horizon truncated pending events. `UNKNOWN` is never
  reported as `SAFE` and carries no certificate.

## Errors

- `ERR_DOMAIN` — negative/non-integer capacity, negative `proc`, wrong
  `buffers.length`, unknown policy, duplicate arrival ids, invalid times.
- `ERR_CYCLE` — event loop detected: too many events at one timestamp or a
  repeated state without time advance.

## API

```js
const { simulate, generateArrivals, minimizePrefix, IncrementalSimulator } = require('./index');

simulate({
  stations: [{ cap: 1, proc: 2 }, { cap: 1, proc: 3 }],
  buffers: [{ cap: 2 }],
  arrivals: [{ id: 'A', time: 0 }, { id: 'B', time: 3 }], // or { seed, count, maxGap, maxPriority }
  policy: 'fifo',
}, { horizon: Infinity });
// => { status, trace, firstViolation, certificate }
```

- `generateArrivals({seed, ...})` — mulberry32 PRNG, pure integer math; the
  same seed yields the identical stream in any process (verified by diffing
  output of two separate `node` invocations).
- `minimizePrefix(config)` — shortest violating prefix of the arrival stream,
  then delta-minimized so that removing ANY single remaining arrival clears
  the violation (1-minimal).
- `IncrementalSimulator` — caches per-event snapshots and policy choice
  points; `setPolicy(p)` restores the snapshot at the first choice point
  whose outcome changes and recomputes only that suffix (`reused` /
  `recomputed` counts in the result). Unaffected changes reuse the whole
  trace with zero recomputation.

## Tests

`npm test` (i.e. `node --test`). Real recorded result on Node v22.22.1:

```
# tests 1        (test/sim.test.js, 16 subtests)
# pass 1
# fail 0
16/16 subtests ok, 0 failing
```

Coverage: 12-event hand-enumerated reference trace; capacity-0 and
empty-arrival edges; constructed overflow with 1-minimal prefix
(`{A,B,C}`, every single removal is SAFE); stable same-time tie-break;
seed reproducibility across processes; `ERR_DOMAIN` / `ERR_CYCLE`;
SAFE certificate and UNKNOWN-never-SAFE; starvation earliest time;
fifo/priority divergence; incremental suffix recomputation
(`reused=8, recomputed=4` on the contested-buffer scenario, trace equal to
a fresh full simulation).
