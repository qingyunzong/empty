# constrained-sampler

Sample generation for finite integer parameters under input constraints.
TypeScript, zero runtime dependencies.

## Features

- **Exact enumeration** with constraint pruning (`enumerateSolutions`).
- **Fixed-seed random sampling** (`sampleRandom`): same seed, same samples.
- **Distinct outcomes**: `unsatisfiable` (proven no solution) is never
  confused with `budget-exhausted` (search stopped early).
- **Dependency validation**: `defineProblem` rejects constraints that
  reference undeclared variables (`UnknownVariableError`).
- **Constraint-preserving shrink** (`shrink`): reduces a sample toward
  domain minimums while keeping every constraint satisfied.
- **Short-domain exactness**: when the search space fits the attempt
  budget, random sampling falls back to exact enumeration, so
  unsatisfiability is decided precisely and no invalid sample is produced.

## Usage

```ts
import { defineProblem, enumerateSolutions, sampleRandom, shrink } from './src/index.ts';

const problem = defineProblem({
  variables: [
    { name: 'x', min: 0, max: 10 },
    { name: 'y', min: 0, max: 10 },
  ],
  constraints: [
    { vars: ['x', 'y'], check: (g) => g('x') + g('y') >= 8 },
  ],
});

enumerateSolutions(problem);                    // { status: 'complete', samples: [...] }
enumerateSolutions(problem, { budget: 5 });     // { status: 'budget-exhausted', ... }
sampleRandom(problem, { seed: 42, count: 5 });  // reproducible samples
shrink(problem, { x: 9, y: 9 });                // smallest still-valid sample
```

`GenResult.status` is one of:

- `complete` — search finished (or requested sample count reached);
- `unsatisfiable` — proven that no solution exists;
- `budget-exhausted` — stopped early; unsatisfiability not established.

## Test

```sh
npm test        # compiles with tsc, then runs node:test suites
npm run typecheck
```

Requires a `tsc` compiler on PATH (e.g. `npm i -g typescript`) and Node 18+.
