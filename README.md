# incremental-spreadsheet

A TypeScript spreadsheet engine with lazy, incrementally maintained evaluation.

## Features

- **Integer arithmetic**: `+`, `-`, `*`, `/` (truncating division), unary minus, parentheses.
- **Cell references**: `A1`-style refs, lazily resolved with cached values and dirty propagation.
- **`IF(cond, then, else)`**: only the executed branch is evaluated, so only the executed
  branch establishes dependencies (`cond` is true when non-zero).
- **Dynamic dependency tracking**: dependencies are recorded while a formula evaluates and
  rebuilt whenever the formula is modified or re-evaluated.
- **Cycle detection**: circular references produce a `cycle` error carrying the access path
  (e.g. `A1 -> B1 -> A1`); dependents of a cycle see the error instead of stale values.
- **Division by zero**: produces a `div-by-zero` error value that propagates to dependents,
  replacing previously cached values rather than leaking them.
- **Transactions**: `begin()` / `commit()` / `rollback()` (nestable); rollback restores
  formulas, cached values, and the dependency graph.

## API

```ts
import { Spreadsheet } from './src/sheet';

const sheet = new Spreadsheet();
sheet.set('A1', 5);
sheet.set('B1', '=IF(A1, A1 * 2, 1/0)');
sheet.get('B1');                 // { ok: true, value: 10 }
sheet.dependenciesOf('B1');      // ['A1']
sheet.set('A1', 0);
sheet.get('B1');                 // { ok: false, error: { type: 'div-by-zero' } }

sheet.begin();
sheet.set('A1', 42);
sheet.rollback();                // formulas, values and dependencies restored
```

## Tests

```sh
npm test
```

Compiles with `tsc` and runs `node:test` suites, including a randomized differential test
that compares the incremental engine against a naive full-sheet re-evaluation oracle
(values and direct dependency sets) after every mutation.
