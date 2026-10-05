# resumable-graph-search

Best-first search (A*-style, `f = g + h`) over a finite state graph, written in
TypeScript with **Node.js built-in modules only** (no runtime dependencies).
The search can be cancelled at any expansion boundary and later resumed from a
JSON-serializable snapshot with output **identical** to an uninterrupted run.

## Guarantees

- **Snapshot completeness** — a `Snapshot` captures everything needed to
  resume: the dedup set (`bestG`: best known g-cost per state key), the
  priority queue (`open`: raw heap array, restored verbatim), and the
  deterministic ordering (`nextSeq`: the tie-break insertion counter), plus
  progress (`expanded`, `visits`) and the best candidate so far.
- **Deterministic order** — queue entries are ordered by `(f, seq)`; `seq` is
  a persisted monotonic counter, so ties always break by insertion order and
  the expansion sequence is fully determined by problem + snapshot.
- **Cancel / resume transparency** — resuming from a snapshot (even after a
  `JSON.stringify`/`JSON.parse` round-trip) yields the same visit sequence,
  visit counts, and final result as one uninterrupted run.
- **Budget exhaustion** — when the expansion budget runs out, the search
  returns the live frontier (sorted in pop order) and the best candidate
  (expanded state with min `h`, then min `f`, then earliest). The included
  snapshot allows continuing later with a larger budget.

## API

```ts
import { runSearch, Problem, Snapshot } from "resumable-graph-search";

const problem: Problem<MyState> = {
  start,
  isGoal: (s) => /* ... */,
  successors: (s) => /* deterministic edge order */,
  key: (s) => /* stable dedup key */,
  heuristic: (s) => /* estimate */,
};

// Run a slice; cancel after 100 expansions.
let result = runSearch(problem, { cancelAfter: 100, budget: 10_000 });
if (result.outcome.status === "cancelled") {
  const snapshot = result.outcome.snapshot;       // JSON-serializable
  result = runSearch(problem, { snapshot, cancelAfter: 100, budget: 10_000 });
}
if (result.outcome.status === "budget-exhausted") {
  console.log(result.outcome.frontier);           // live open set, pop order
  console.log(result.best);                       // best candidate so far
}
```

## Layout

- `src/heap.ts` — deterministic binary min-heap ordered by `(priority, seq)`,
  serializable via `toArray()` / `MinHeap.fromArray()`.
- `src/search.ts` — `runSearch(problem, options)` with `budget`,
  `cancelAfter`, and `snapshot` options; `Snapshot`, `FrontierEntry`,
  `BestCandidate` types.
- `test/` — `node:test` suites and a deterministic seeded graph generator.

## Test

Requires Node.js (developed on v22) and a `tsc` on PATH (TypeScript 7 used
here). No `npm install` needed — there are no dependencies.

```
npm test
```

### Actual recorded results (2026-10-05, Node v22.22.1, tsc 7.0.2)

`npm test` output:

```
> npm run build && node --test "dist/test/*.test.js"
TAP version 13
# Subtest: dist/test/heap.test.js
ok 1 - dist/test/heap.test.js
# Subtest: dist/test/search.test.js
ok 2 - dist/test/search.test.js
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Individual cases (10/10 passing):

```
heap.test.js
ok 1 - pops in (priority, seq) order, ties broken by insertion order
ok 2 - snapshot round-trip preserves the exact pop sequence
ok 3 - fromArray isolates the heap from later pushes to the source
# tests 3  # pass 3  # fail 0

search.test.js
ok 1 - uninterrupted run is deterministic across repetitions
ok 2 - random cancel points: resumed output matches uninterrupted run
ok 3 - budget exhaustion returns frontier and best candidate
ok 4 - resuming a budget-exhausted search matches the uninterrupted run
ok 5 - deterministic expansion order with tied priorities
ok 6 - unreachable goal exhausts the frontier
ok 7 - cancelAfter=0 cancels immediately with a resumable snapshot
# tests 7  # pass 7  # fail 0
```

The "random cancel points" test runs 40 trials on a seeded 60-state /
180-edge graph: each trial cancels at random slice lengths (0–5 expansions,
seeded mulberry32 PRNG), round-trips every snapshot through JSON, and asserts
the resumed run's visit order, visit count, and final result deep-equal the
uninterrupted baseline.
