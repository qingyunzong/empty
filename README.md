# rule-expr

A rule expression library in TypeScript using only Node.js built-in modules
(no runtime dependencies). Parsing and execution are fully separated:
`parse()` produces an immutable AST with source spans, `evaluate()` / `start()`
run it against a variable context.

## Language

```
def fact(n) = n == 0 ? 1 : n * fact(n - 1);
let limit = 100 in fact(10) > limit ? fact(10) : -1
```

- **Integer arithmetic** with arbitrary precision (`bigint`): `+ - * / %`,
  unary `-`. Division and modulo truncate toward zero. Division by zero
  raises `EvalError` **only when the expression is actually evaluated** —
  unselected ternary/short-circuit branches and unread function arguments
  never trigger it.
- **Comparison**: `== != < <= > >=`. **Booleans**: `true false ! && ||`
  with short-circuiting. **Ternary**: `cond ? a : b` (condition must be boolean).
- **Variables** come from the host (`vars` option) or `let name = expr in body`.
  A missing variable raises `EvalError` carrying the source range
  (`error.span`, `error.range` with line/column).
- **Functions**: `def f(a, b) = expr;` definitions and `fn(a, b) => expr`
  lambdas. Lexical scoping; closures capture environment frames (bindings),
  not copies of values, so a cached lazy binding is shared with its closures.
- **Lazy parameters** (call-by-need): an argument is evaluated on first read
  and the result — value *or* error — is cached. An unread argument is never
  evaluated (no error), and a cached failure is rethrown without re-evaluating.
- **Recursion** is bounded by an explicit step budget (`budget` option);
  exceeding it throws `BudgetExhaustedError`.

## API

```ts
import { evaluate, parse, start } from './src/index.ts';

evaluate('1 + 2 * 3');                                  // 7n
evaluate('x * 2', { vars: { x: 21n } });                // 42n

const program = parse('x * 2');                         // parse once...
evaluate(program, { vars: { x: 3n } });                 // ...evaluate many times

// Pausable evaluation: the evaluation stack lives in a suspended generator.
let r = start('def fact(n) = n == 0 ? 1 : n * fact(n - 1); fact(30)',
              { budget: 1_000_000, pauseEvery: 100 });
while (r.status === 'paused') r = r.resume();           // save/restore `r` as needed
// r.value === one-shot result, r.steps identical to an uninterrupted run
```

Host variables may be plain values (`bigint`/`boolean`) or lazy providers
`() => Value`, which are fetched at most once and only when read.

## Scripts

- `npm test` — compile with `tsc` and run the test suite (`node --test`).
- `npm run typecheck` — strict type checking (`tsc --noEmit`).

## Test results (recorded 2026-10-07, Node v22.22.1, tsc 7.0.2)

`npm test` output summary:

```
# tests 6
# pass 6
# fail 0
```

All 6 test files pass, 34 assertions groups in total:

| file                    | tests | status |
|-------------------------|-------|--------|
| arithmetic.test.js      | 5     | pass   |
| control.test.js         | 6     | pass   |
| functions.test.js       | 9     | pass   |
| pause.test.js           | 4     | pass   |
| recursion.test.js       | 4     | pass   |
| variables.test.js       | 6     | pass   |

Coverage highlights:

- division/modulo truncation toward zero for all sign combinations;
- division by zero errors only in evaluated positions (ternary branches,
  `&&`/`||` right-hand sides, unread function arguments stay silent);
- missing-variable errors carry `{start,end}` offsets and line/column range;
- arbitrary precision: 30-digit literals and `fact(40)` exact bigint results;
- lazy parameters evaluated once (counted via instrumented host providers),
  cached errors rethrown without re-evaluation;
- closures capture bindings: a shared lazy argument is evaluated once across
  two closure invocations;
- recursion stops with `BudgetExhaustedError` when the step budget is exceeded;
- pause/resume with `pauseEvery` of 1, 2, 3, 7, 100 all produce the same value
  and the same total step count as a single uninterrupted run.
