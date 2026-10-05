# pbt-contract

A minimal property-based testing library in TypeScript, built only on
Node.js built-in modules (tests run on `node:test`). No dependencies.

## Features

- **Serializable seeds** — the master seed is a plain string
  (`src/rng.ts`). `check()` derives each run's stream via
  `deriveSeed(seed, runIndex)`, so a run is fully reproducible from the
  seed printed in the report.
- **Trees, sequences, operation histories** — `treeOf`, `arrayOf` /
  `sortedArrayOf`, and `historyOf` (command sequences generated valid
  by construction against a model) in `src/arbitrary.ts`.
- **Contract-preserving shrinking** — every `Arbitrary` carries a
  `contract`; `shrink(v)` only emits values satisfying it, and the
  shrink engine (`src/shrink.ts`) filters candidates through
  `contract` again before testing. The minimal counterexample always
  satisfies the input contract.
- **Single-step irreducible results** — the greedy shrinker stops only
  when no one-step shrink candidate is still interesting, so the
  returned value cannot be shrunk further in a single step
  (verified by `test/helpers.ts: assertSingleStepIrreducible`).
- **Failure vs. test exception** — a property returning `false` is a
  falsification (`status: "falsified"`); a thrown error is a test
  exception (`status: "error"`, with the message captured). The two
  are never conflated (`src/check.ts`).
- **Actual check trace** — every generated input and every evaluated
  shrink candidate is recorded with its outcome
  (`pass` / `fail` / `error` / `skip`) in `report.trace`.
- **Resumable shrink checkpoints** — `ShrinkCheckpoint` is plain JSON
  (`seed`, `current`, `testedHashes`, `trace`, ...). Candidates are
  identified by a stable 64-bit FNV-1a hash of their canonical
  serialization (`src/hash.ts`); `resumeShrink` skips any candidate
  whose hash was already tested, so resumed sessions never re-test.

## Usage

```ts
import { check, integer, sortedArrayOf } from "./src";

const arb = sortedArrayOf(integer(0, 20), { minLength: 1, maxLength: 8 });
const report = check(arb, (v) => v.reduce((a, b) => a + b, 0) <= 10, {
  seed: "demo-seed",
  numRuns: 200,
});
// report.status === "falsified", report.minimal === [11],
// report.trace contains every evaluated candidate.
```

Resumable shrinking:

```ts
import { shrink, resumeShrink } from "./src";

const part = shrink(arb, isInteresting, value, { maxTests: 2 });
const saved = JSON.stringify(part.checkpoint);   // persist anywhere
const done = resumeShrink(arb, isInteresting, JSON.parse(saved));
```

## Scripts

- `npm test` — compile (`tsc`) and run the test suite (`node:test`).
- `npm run demo` — print a real check trace and a checkpoint/resume run.

See `RESULTS.md` for the actual recorded output.
