# line-side-buffer-sim

Offline discrete-event simulation and certificate generation for electronics
assembly line-side buffers. Given stations, buffers, seeded arrivals and a
dispatch policy, it answers: **does any station starve or any buffer overflow,
and if so, at which earliest time?** Pure Node.js 22 standard library; tests
use `node:test`.

## Model

- `stations: [{cap, proc}]` — serial line; `cap` parallel slots, `proc`
  processing time per item.
- `buffers: [{cap}]` — exactly `stations.length + 1` buffers; `buffers[i]`
  feeds `stations[i]`; the last buffer is the shipping buffer.
- `arrivals` — either `{times: [...], priorities?, seed?, priorityLevels?}`
  (explicit times; priorities explicit or drawn from the seeded stream) or
  `{seed, count, start?, maxInterval?, priorityLevels?}` (generated).
- `policy` — `'fifo'` (oldest item) or `'priority'` (smallest
  `(priority, id)` pair; stable).
- Optional: `horizon`, `stateBudget`, `cycleLimit`, `customEvents`.

### Event semantics (per timestamp, fixed order)

1. settle: completions due now, then work-conserving pulls (fixpoint, so
   zero-`proc` cascades fully propagate);
2. custom events;
3. arrivals in stable id order (same-time arrivals are tie-broken by id);
4. settle again;
5. starvation check.

A station **starves** when it has a free slot, an empty input buffer, and
upstream work exists (pending arrivals, items in earlier buffers, busy
earlier stations). Stations that have never been busy are still ramping up
and are not reported. A buffer **overflows** when an item must enter a full
buffer.

## API

```js
import { simulateLine, IncrementalSimulation } from './src/index.js';

const result = simulateLine(config);
// {
//   status: 'SAFE' | 'VIOLATION' | 'UNKNOWN',
//   trace: [{seq, time, type, item?, station?, buffer?}, ...],
//   firstViolation: null | {type: 'bufferOverflow'|'starvation', time, ...},
//   certificate: null | {covered, horizon, statesExplored, transitions,
//                        maxOccupancy, violations, digest},
//   minimalPrefix: null | {arrivals: [id,...], verifies},
// }
```

- `VIOLATION` — `firstViolation` is the earliest violation on the
  deterministic trajectory; for overflows, `minimalPrefix` is a 1-minimal set
  of arrivals (delta-debugged) that still overflows: deleting any one of them
  eliminates the overflow.
- `SAFE` — only when the certificate covers the whole reachable state space
  within the finite horizon (all dequeue tie-break alternatives explored, no
  violation found, exploration within `stateBudget`, no reachable event
  beyond `horizon`). **`UNKNOWN` is never reported as `SAFE`.**
- `UNKNOWN` — the certificate is incomplete (budget exhausted or events
  beyond the horizon); inspect `certificate` for details.

### Determinism

Arrivals and priorities come from a pure-integer mulberry32 PRNG, so the same
seed reproduces bit-identical results across processes and platforms.

### Incremental re-simulation

```js
const inc = new IncrementalSimulation(config);
inc.run();                       // records checkpoints at policy-sensitive
                                 // decisions (dequeue from a >= 2-item buffer)
const { result, stats } = inc.setPolicy('priority');
// stats: {divergenceTime, reusedEvents, recomputedEvents, totalEvents}
```

Only the suffix from the first decision whose outcome differs under the new
policy is recomputed; the prefix is reused verbatim.

## Errors

- `ERR_DOMAIN` — negative/non-integer capacities, negative `proc`, negative
  arrival times, wrong buffer count, unknown policy, etc.
- `ERR_CYCLE` — event cycles: custom events that do not quiesce at one
  timestamp, events scheduled in the past, or an identical state reached
  twice at one time.

## Tests

```sh
node --test
```

See `RESULTS.md` for the recorded real output.
