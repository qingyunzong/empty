# mini-sheet

A dependency-tracking spreadsheet engine in TypeScript.

## Features

- **Integer arithmetic**: `+ - * /`, parentheses, unary minus; division truncates
  toward zero. Comparisons (`= <> < <= > >=`) yield `1`/`0` for use in `IF`.
- **Cell references**: `A1`-style, case-insensitive; empty cells read as `0`.
- **IF(cond, then, else)**: only the actually executed branch is evaluated, so
  only its references become dependencies.
- **Incremental re-tracking**: editing a cell invalidates only its transitive
  dependents; dependency edges are dropped and re-recorded on next evaluation.
- **Cycle detection**: circular references produce a `#CYCLE!` error carrying
  the full access path (e.g. `A1 -> B1 -> C1 -> A1`); breaking the cycle
  restores normal values.
- **Division by zero**: produces `#DIV/0!` (propagating to dependents) instead
  of ever serving a stale cached value; fixing the divisor recovers cleanly.
- **Transactions**: `beginTransaction` / `commit` / `rollback` (nestable).
  Rollback restores formulas, cached values and the dependency graph.
- **Cross-checking**: `evaluateAll()` re-evaluates every cell straight from the
  stored formulas, bypassing the cache, so tests can diff the incremental
  engine against full-table evaluation.

## Usage

```ts
import { Spreadsheet } from "./src/sheet";

const s = new Spreadsheet();
s.setCell("A1", 1);
s.setCell("B1", "=IF(A1, C1, D1) * 2");
s.getValue("B1");            // { kind: "num", value: 0 } (C1 empty -> 0)
s.getDependencies("B1");     // ["A1", "C1"]  (D1 not tracked: branch not taken)

s.beginTransaction();
s.setCell("A1", 0);
s.getValue("B1");            // now reads D1
s.rollback();                // formulas, values and dependencies restored
```

## Scripts

- `npm test` — compile with `tsc` and run the `node:test` suite in `test/`.
- `npm run build` — compile only (output in `dist/`).

No runtime or dev dependencies; requires Node.js >= 18 and a `tsc` compiler.
