# table-grid-editor

Table editing core in TypeScript, built on an **expanded-cell model**: every
grid position records the anchor of the merge covering it, values live only
on anchor cells, and every mutation is validated against this model before
it is applied (`checkExpandedModel()` re-verifies the invariants).

## API

```ts
import { TableGrid } from './src/table.js';

const g = new TableGrid<number>(10, 6);
g.setValue(0, 0, 42);
g.merge({ row: 0, col: 0, rows: 2, cols: 3 });   // rectangular merge
g.split(1, 2);                                    // split merge covering a cell
g.copy({ row: 0, col: 0, rows: 2, cols: 3 }, 4, 1); // cross-region copy
g.applyBatch([                                    // atomic: all-or-nothing
  { type: 'set', row: 5, col: 5, value: 7 },
  { type: 'merge', rect: { row: 5, col: 5, rows: 2, cols: 2 } },
  { type: 'copy', src: { row: 5, col: 5, rows: 2, cols: 2 }, dstRow: 0, dstCol: 0 },
]);
```

All mutators return `{ ok: true } | { ok: false, error }` — no exceptions
for rule violations, and a rejected operation never modifies the grid.

## Copy rules

- **Source integrity**: every merge touched by the source rect must lie
  fully inside it, otherwise `MERGE_CLIPPED`.
- **Target integrity**: every existing merge touched by the target rect must
  be fully covered by it, otherwise `TARGET_MERGE_PARTIAL`; fully covered
  merges are replaced by the copied content.
- **Snapshot semantics**: the source is snapshotted before any write, so
  overlapping source/target regions copy pre-copy values without pollution.

## Batch atomicity

`applyBatch` runs the operations against a private clone and commits only
when all succeed; on failure the grid is untouched and the error carries the
failing operation's `index`.

## Test

```sh
npm test   # tsc && node --test (no install needed, zero dependencies)
```
