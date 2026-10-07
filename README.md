# lazy-eval

Integer expression evaluator in TypeScript with shared, lazy `let` bindings.

## Features

- **Integer expressions**: literals, `add`/`sub`/`mul`/`div` (truncating division,
  division by zero is a diagnostic).
- **Shared lazy `let`**: each binding is compiled to a thunk that is evaluated at
  most once; the result is shared between all references.
- **First evaluation caches success or failure**: a thunk is either `done` with a
  value or `failed` with a diagnostic. Re-forcing a failed thunk throws the
  *identical* `EvalDiagnostic` instance.
- **Black holes**: forcing a thunk that is already `in-progress` (self- or
  mutually-dependent bindings) raises a `BLACK_HOLE` diagnostic instead of
  diverging.
- **Observable forcing**: pass a `trace` array to receive `force`, `value`,
  `failure`, `cache-hit`, and `black-hole` events in order.
- **Budget**: `budget` caps the number of AST nodes actually evaluated; cache
  hits and black-hole re-entries are free. `evaluator.spent` reports consumption.
- **Non-shared interpreter**: `evaluateNaive` re-evaluates bindings at every
  reference (call-by-name, no caching) and is used to cross-check numeric
  results and to demonstrate the work saved by sharing.

## Usage

```ts
import { Evaluator, letIn, add, mul, lit, v } from "./src";

const ev = new Evaluator({ budget: 100, trace: [] });
ev.evaluate(letIn("x", add(lit(2), lit(3)), mul(v("x"), v("x")))); // 25
```

## Tests

```sh
npm test
```

Compiles with `tsc` (TypeScript >= 5, uses the globally installed compiler) and
runs the suite with the Node built-in test runner. No npm dependencies.
