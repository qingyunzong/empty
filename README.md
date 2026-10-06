# form-visibility-fixedpoint

A form library where each field's visibility is a boolean expression over
field values and field visibility.

## Semantics

- **Conditions** are boolean expressions (`and` / `or` / `not` / literals)
  over two kinds of atoms: `v(f)` (value of field `f`) and `vis(f)`
  (whether field `f` is visible).
- **Hidden fields are unfilled**: `v(f)` of a hidden (or never filled)
  boolean field reads as `false`.
- **Cyclic dependencies** are resolved as the *least fixed point* of the
  visibility operator, computed by monotone iteration starting from the
  all-hidden state. Each round reveals every still-hidden field whose
  condition holds under the previous round's visible set (round-atomic),
  so the visible set only grows and the iteration always terminates.
- **Non-monotone hidden references are rejected**: any `v(f)` or `vis(f)`
  atom under an odd number of negations makes the condition non-monotone
  in the visible set, so construction throws `NonMonotoneConditionError`.
  (Double negation is positive and allowed.)
- **Batch updates are atomic**: `form.applyBatch(patch)` merges the whole
  patch first, then recomputes the fixed point exactly once, returning the
  per-round changes (`rounds`) plus the diff against the previous state
  (`becameVisible` / `becameHidden`).

## Example

```ts
import { Form, lit, v, vis, and } from './src/index.js';

const form = new Form([
  { name: 'a', condition: lit(true) },
  { name: 'b', condition: v('a') },          // visible once a is filled true
  { name: 'c', condition: and(vis('b'), v('a')) },
]);

const result = form.applyBatch({ a: true });
// result.rounds: [{ round: 1, revealed: ['a'], ... },
//                 { round: 2, revealed: ['b'], ... },
//                 { round: 3, revealed: ['c'], ... }]
```

## Tests

```
npm test
```

Compiles with `tsc` and runs `node --test`. The suite includes an
exhaustive finite truth-table verification: for all 2^4 value assignments
of a 4-field form (including a positive cycle), it checks that the
computed visibility is a fixed point, that it is the least one (by
enumerating every subset of fields), that the per-round changes replay
consistently, and that hidden fields are unfilled in the effective view.
