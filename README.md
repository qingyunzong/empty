# pbt-mini

A minimal property-based testing library in TypeScript.

## Design guarantees

- **Per-test independent integer random state** — the RNG (`src/rng.ts`,
  SplitMix64) holds a single 64-bit integer state. Each test's seed is
  `deriveSeed(runSeed, testName)` and each iteration draws from
  `Rng(deriveSeed(testSeed, i))`, so results depend only on
  `(seed, testName, iteration)` — never on test execution order or count.
- **Fixed small cases first** — every generator provides `smalls()`, a
  deterministic list of edge cases checked before any random draw, giving a
  stable seed-independent baseline for comparison.
- **Failure persistence** — on failure a JSON record is saved (default
  `failures/`) containing the generation parameters (`seed`, `testName`,
  `iteration`, `kind`) and the full shrink trace.
- **Genuine-failure-only shrinking** — a shrink candidate is accepted only if
  re-running the property on it actually fails (returns `false` or throws).
  Every candidate and its true outcome is recorded in `shrinkTrace`.
- **Replay confirmation** — after shrinking, the final counterexample is
  re-run; if it no longer fails, an unsoundness error is raised (the property
  is non-deterministic). `replay(record, gen, property)` regenerates the
  original value from the saved parameters and confirms both it and the
  counterexample still fail.

## Usage

```ts
import { check, integer, arrayOf } from "./src/index.js";

check(
  (xs: number[]) => xs.reduce((a, b) => a + b, 0) < 20,
  arrayOf(integer(0, 30), { minLength: 1, maxLength: 6 }),
  { runs: 300, seed: 9n, testName: "sum-lt-20" },
);
// throws PropertyFailure with a persisted record and minimal counterexample
```

## Test

```
npm test
```

Compiles with `tsc` to `dist/` and runs the suites in `test/` via
`node --test`. (This Node build lacks native type stripping, so tests run
against compiled output.)
