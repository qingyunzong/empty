# resumable-graph-search

TypeScript library for best-first traversal of a finite state graph with:

- **Cancellation + resume**: `snapshot()` captures the dedup set, the priority
  queue (including per-entry sequence numbers), and all counters as plain
  JSON; `Search.resume()` continues so the output is identical to an
  uninterrupted run.
- **Deterministic ordering**: the heap orders by `(priority, insertion
  sequence)`, so pop/visit order is fully deterministic and survives a
  snapshot round-trip.
- **Budgets**: when the expansion budget is exhausted, the result reports the
  remaining frontier (in exact expansion order) and the top-K best candidates.

No runtime dependencies — Node.js built-ins only (`node:test` for tests).

## Usage

```ts
import { Search, Graph } from "resumable-graph-search";

const graph: Graph<number> = {
  start: () => [0],
  neighbors: (s) => edges[s],
  key: (s) => String(s),
  priority: (s) => dist[s], // lower expands first
  score: (s) => value[s],   // higher is a better candidate
};

const search = Search.start(graph, { budget: 1000, bestK: 10 });
search.cancel();            // takes effect at the next expansion boundary
search.run();

const json = JSON.stringify(search.snapshot());   // persist anywhere
const resumed = Search.resume(graph, JSON.parse(json));
const result = resumed.run(); // identical to an uninterrupted run

result.status;     // "complete" | "budget-exhausted" | "cancelled"
result.visits;     // number of expansions
result.visitOrder; // keys in expansion order
result.frontier;   // remaining open list, in expansion order
result.best;       // top-K candidates by score
```

## Test

```
npm test
```

The suite builds with `tsc` and runs `node --test`. It includes a randomized
campaign (80 seeds) that cancels at random expansion boundaries, round-trips
the snapshot through JSON, resumes, and verifies the final result, visit
count, and visit order against the uninterrupted baseline.

## Recorded results

Environment: Node.js v22.22.1, TypeScript 7.0.2, Linux x86_64.
Actual output of `npm test` (TAP, per-test view via `node dist/test/search.test.js`):

```
# Subtest: uninterrupted runs are deterministic and visit every node once
ok 1 - uninterrupted runs are deterministic and visit every node once
# Subtest: cancel + snapshot + resume matches the uninterrupted run (random cancel points)
ok 2 - cancel + snapshot + resume matches the uninterrupted run (random cancel points)
# Subtest: budget exhaustion returns the frontier and the best candidates
ok 3 - budget exhaustion returns the frontier and the best candidates
# Subtest: snapshot survives a JSON round-trip byte-for-byte
ok 4 - snapshot survives a JSON round-trip byte-for-byte
# Subtest: edge cases: zero budget, immediate cancel, empty graph
ok 5 - edge cases: zero budget, immediate cancel, empty graph
# Subtest: frontier order is the exact expansion order of the remaining open list
ok 6 - frontier order is the exact expansion order of the remaining open list
# Subtest: result objects are snapshots and do not alias live state
ok 7 - result objects are snapshots and do not alias live state
1..7
# tests 7
# pass 7
# fail 0
```

## Layout

- `src/heap.ts` — binary min-heap with `(priority, seq)` deterministic order
- `src/search.ts` — `Search` engine: step/run, cancel, budget, snapshot/resume
- `test/search.test.ts` — determinism, random cancel/resume, budget, edge cases
- `test/random-graph.ts` — seeded PRNG + deterministic random graph generator
