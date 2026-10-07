# timeline-rows

Assign half-open intervals `[start, end)` to the minimum number of display
rows so that overlapping intervals never share a row.

## Rules

- **Half-open intervals**: `[0, 2)` and `[2, 4)` may share a row.
- **Fixed rows honored**: items with `fixedRow` are always placed there.
- **Fixed conflicts reject the batch**: overlapping items pinned to the same
  row throw `FixedRowConflictError` (listing every conflict); nothing is
  assigned.
- **Greedy order**: remaining items are placed in `(start, id)` order, each
  on the lowest row free for its span.
- **Minimum rows**: if fixed constraints push the greedy pass above the true
  minimum, the layout is rearranged exactly (same `(start, id)` / lowest-row
  preference). The exact proof is bounded by `maxSearchSteps`
  (default 200 000); when the bound is hit the valid greedy layout is kept.
- **Re-layout deltas**: pass the previous layout to get per-item move deltas
  (`from`/`to`, `null` marks additions/removals), sorted by id.

## API

```ts
import { layoutTimeline, minRowsExhaustive } from "timeline-rows";

const result = layoutTimeline(
  [
    { id: "a", start: 0, end: 4 },
    { id: "b", start: 1, end: 2, fixedRow: 1 },
    { id: "c", start: 3, end: 5 },
  ],
  previousRows // optional Map or { id: row } object
);
// result.rowCount  -> number of rows (minimum)
// result.rows      -> Map<id, row>
// result.moves     -> [{ id, from, to }] deltas vs previousRows
```

`minRowsExhaustive(items)` computes the exact minimum by unbounded
backtracking — exponential, meant for small instances (used by the test
suite to verify `layoutTimeline`).

## Development

```sh
npm test   # compiles TypeScript and runs the node:test suite
```
