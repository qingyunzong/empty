# interval-stream-join

Streaming equi-join over two streams of half-open time intervals `[start, end)`,
with watermark-driven state reclamation, bounded buffers and backpressure.
Zero runtime dependencies; TypeScript source, compiled with `tsc`.

## Semantics

- **Join**: every `(left, right)` pair with a non-empty intersection emits one
  `JoinMatch { leftId, rightId, start, end }` carrying both source ids and the
  exact intersection bounds. Touching intervals (`end == start`) do not match.
- **Watermarks**: each side has a monotone watermark. An event arriving on a
  side with `start < watermark[side]` is rejected as `"late"`.
- **Reclamation**: when side S's watermark advances to `W`, buffered items on
  the *opposite* side with `end <= W` are evicted — any future event on S must
  have `start >= W` and cannot overlap them, so eviction loses no matches.
- **Backpressure**: each side's buffer is bounded. `push` into a full buffer
  returns status `"full"` and does **not** consume the event; retry after
  advancing a watermark, or use `pushAsync` to await free capacity.

## Usage

```ts
import { IntervalJoin } from "./src/interval-join.js";

const join = new IntervalJoin({ leftCapacity: 1000, rightCapacity: 1000 });

join.push("left", { id: "L1", start: 0, end: 10 });
const { status, matches } = join.push("right", { id: "R1", start: 5, end: 8 });
// status === "accepted"
// matches === [{ leftId: "L1", rightId: "R1", start: 5, end: 8 }]

join.advanceWatermark("left", 10); // evicts right-side items with end <= 10
```

`fullPairwiseJoin(left, right)` is the offline brute-force reference used to
cross-check streaming results (see the randomized test).

## Test

```sh
npm test   # tsc build + node --test
```

Covers: intersection bounds and ids, half-open boundaries, invalid/late
rejection, watermark eviction exactness, capacity backpressure (sync and
async), and a seeded randomized out-of-order cross-check against the offline
full-pairwise reference.
