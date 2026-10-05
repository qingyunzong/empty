# sliding-quantile-store

Fixed-size sliding-window quantile statistics over duplicate integers, built
on a persistent order-statistics index, with event-id corrections, branch
merging, conflict rank bounds and atomic conflict resolution.
TypeScript + Node.js built-in modules only (no npm dependencies).

## Layout

- `src/treap.ts` — persistent (immutable) order-statistics treap. Each node
  stores `count` (duplicate multiplicity) and `size` (subtree cardinality),
  giving O(log n) expected rank/select. Every mutation path-copies, so old
  roots remain valid readable snapshots.
- `src/quantile.ts` — quantile rank rule: for rational `p = pNum/pDen` and
  window size `n`, the quantile is the value at rank `ceil(p*n)` (1-based);
  `p = 0` clamps to rank 1, i.e. the minimum. BigInt ceiling division keeps
  the rank exact for any rational.
- `src/window.ts` — immutable sliding-window state: `addEvent` (evicts the
  oldest event when full), `removeEvent` (delete by event id),
  `correctEvent` (value correction by event id), `quantile` (returns `null`
  for an empty window). Operations return new states; inputs are never
  mutated.
- `src/repo.ts` — versioned repository. Every committed state gets an
  immutable version id. Branches record corrections relative to a shared
  base version. `merge(L, R)` applies agreed corrections and turns the same
  event corrected to two different values into a `Conflict`. While
  conflicts are open, `quantileBounds(p)` returns the certain part plus
  uncertain rank bounds (all-min / all-max choice multisets give exact
  lower/upper values at the target rank), and `rankBounds(v)` bounds the
  rank of a value. `resolve(choices)` picks `'left' | 'right'` per conflict
  and atomically publishes the fully-resolved window as one new version;
  old versions and the conflicted view stay readable.
- `src/model.ts` — brute-force reference model (plainly sorted array) used
  by the tests to cross-check everything per step.

## Verification approach

- Per-step sorted check: randomized add/delete/correct sequences are
  replayed against `ModelWindow`; after every step the full sorted contents,
  the extreme quantiles (`p = 0` minimum, `p = 1` maximum), the median and
  duplicate multiplicities are compared.
- Conflict bounds: every combination of the two sides' choices
  (`2^k` resolutions) is enumerated independently with plain sorting, and
  each reported rank bound is checked against the exact min/max over all
  combinations.
- Atomic publish: resolving publishes exactly one new version; pre-merge
  versions and the conflicted merged view are re-queried afterwards to
  prove they are unchanged.

## Commands

```sh
npm test        # tsc compile + node --test
npm run typecheck
```

See `TEST-RESULTS.md` for the recorded actual output.
