# pbtree

A property-based testing library in TypeScript built **only on Node.js
built-ins** (no runtime dependencies; tests use `node:test` + `node:assert`).

## Features

- **Serializable seeds** — `Rng` (xoshiro128**) snapshots to 4 uint32 words
  and round-trips through JSON; `caseRng(seed, runIndex)` deterministically
  reproduces any generated case (`src/rng.ts`).
- **Shrink trees** — generators produce lazy `Tree<T>` values; integers,
  sequences (`array`), tuples, `oneOf`, `map`/`filter` combinators
  (`src/tree.ts`, `src/arbitrary.ts`).
- **Operation histories** — `operationHistory(machine)` generates command
  sequences for model-based testing, threading a pure model so generation
  always satisfies preconditions (`src/commands.ts`).
- **Contract-preserving shrinking** — `filterTree` never exposes a
  contract-violating candidate to the property; invalid nodes are
  *lifted* (their children take their place) so shrinking walks through
  invalid values and still reaches the true single-step minimum.
- **Single-step irreducible results** — the greedy shrinker stops only when
  no direct child fails (`isMinimal: true` in `CheckResult`).
- **Failure ≠ exception** — returning `false` is a `failure` (status
  `"failed"`); throwing is an `exception` (status `"error"`, with
  `errorMessage`). Both are recorded per-candidate in the trace.
- **Actual check trace** — every evaluated candidate is recorded in
  `result.trace` with index, phase (`generate`/`shrink`), serialized value,
  and outcome.
- **Resumable shrinking** — `maxShrinkSteps` pauses shrinking and returns a
  JSON `checkpoint` (seed, run index, tree path, tested-candidate set).
  `resume(params, checkpoint)` regenerates the same tree and continues
  **without re-evaluating any previously tested candidate**.

## Usage

```ts
import { check, resume, integer, operationHistory } from "pbtree";

const result = check({
  arb: integer(0, 1000),
  property: (n) => n < 50,     // return false => failure; throw => exception
  seed: 7,
  numRuns: 100,
});
// result.status === "failed", result.counterexample === 50,
// result.isMinimal === true, result.trace => full evaluation log

// Pause/resume shrinking:
const paused = check({ arb: integer(0, 100000), property: (n) => n < 500,
                       seed: 13, maxShrinkSteps: 4 });
const finished = resume({ arb: integer(0, 100000), property: (n) => n < 500 },
                        paused.checkpoint!);
```

## Test

```
npm test     # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

## Actual recorded results (2026-10-06, Node v22.22.1, tsc 7.0.2)

`npm test` — **15/15 tests pass**:

```
ok 1 - serializable seed / rng
    ok 1 - snapshot round-trips through JSON and reproduces the stream
    ok 2 - same seed generates identical values; different seeds differ
    ok 3 - identical seeds reproduce identical check traces
ok 2 - shrinking
    ok 1 - integer counterexample shrinks to the single-step minimum
    ok 2 - sequence counterexample shrinks to minimal length and contents
    ok 3 - shrinking preserves the input contract on every candidate
    ok 4 - final counterexample is irreducible by one shrink step
ok 3 - failure vs exception
    ok 1 - returning false is a failure
    ok 2 - throwing is an exception, reported as error
    ok 3 - passing properties report passed with full trace
ok 4 - operation history
    ok 1 - shrinks to a minimal valid history and keeps the contract
ok 5 - shrink checkpoint / resume
    ok 1 - budget exhaustion pauses with a serializable checkpoint
    ok 2 - resume finishes the shrink without re-testing candidates
    ok 3 - resumed shrink reaches the same result as an uninterrupted one
ok 6 - check trace
    ok 1 - trace records every evaluated candidate in order
# tests 15  # pass 15  # fail 0
```

Actual check trace emitted by the trace test (seed=7, property `n < 50`,
shrink converges to 50 and verifies no single-step child fails):

```
#6  shrink   value=45 -> pass
#7  shrink   value=48 -> pass
#8  shrink   value=50 -> failure
#9  shrink   value=25 -> pass
#10 shrink   value=38 -> pass
#11 shrink   value=44 -> pass
#12 shrink   value=47 -> pass
#13 shrink   value=49 -> pass
```

## Layout

- `src/rng.ts` — serializable seeded PRNG
- `src/tree.ts` — lazy shrink tree, `map`/`filter` (contract-preserving)
- `src/arbitrary.ts` — generators: integer, boolean, array, tuple, oneOf, …
- `src/commands.ts` — model-based operation histories
- `src/check.ts` — runner: trace, failure/exception, shrink, checkpoint/resume
- `test/pbtree.test.ts` — `node:test` suite
- `types/node-shim.d.ts` — ambient types for `node:test`/`node:assert`
  (avoids any npm dependency)
