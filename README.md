# lazy-shared-eval

Integer expression evaluator with shared lazy `let` bindings.

- **Expressions**: integer literals, `add`/`sub`/`mul`/`div` (truncating), variables, recursive `let`.
- **Sharing**: each `let` binding compiles to one thunk; the first force caches
  success *or* failure, and later forces replay the identical value or the
  identical diagnostic object.
- **Black hole**: forcing a thunk that is already being forced (self-dependency,
  e.g. `let x = x in x`) raises `BlackHoleError`, which is itself cached.
- **Observable forcing order**: `evaluator.trace` lists the labels of nodes in
  the order their evaluation actually started; cache hits never appear.
- **Budget**: `new LazyEvaluator({ budget })` charges one unit per actually
  evaluated node only. `BudgetExhaustedError` is never cached — top up with
  `addBudget(n)` and re-force to resume.
- **Cross-checked**: `src/interp.ts` is a non-sharing reference interpreter;
  `test/crosscheck.test.ts` verifies the caching evaluator agrees with it on
  hundreds of generated programs (values and first diagnostics).

## Usage

```ts
import { LazyEvaluator } from './src/lazy.js';
import { add, letIn, lit, variable } from './src/expr.js';

const ev = new LazyEvaluator({ budget: 100 });
const expr = letIn('x', add(lit(1), lit(1)), add(variable('x'), variable('x')));
ev.run(expr);        // { ok: true, value: 4 }
ev.trace;            // ['let x', 'add', 'x', 'add', 'lit(1)', 'lit(1)']
ev.evaluations;      // 6 — 'x' appears once despite two references
```

## Test

```sh
npm test   # tsc + node --test
```
