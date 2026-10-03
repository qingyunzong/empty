# quota-freeze-model

Randomized state-verification library and CLI for a quota freeze model,
using only the Node.js 22 standard library and `node:test`.

## Model

Each account has a `limit`; the safety invariant is `used + frozen <= limit`.
Every task has two ordered steps, `reserve` (`R`) then `complete` (`C`).
Steps of one participant keep their order; steps of different participants
may interleave freely.

| task          | reserve                                   | complete            |
| ------------- | ----------------------------------------- | ------------------- |
| `freeze`      | hold `amount` in `frozen`                 | `frozen` -> `used`  |
| `unfreeze`    | cancel an incomplete freeze, release hold | bookkeeping         |
| `debit`       | hold `amount` of available quota          | hold -> `used`      |
| `cancelDebit` | restore the hold of an incomplete debit   | bookkeeping         |

Illegal applications — unknown task, out-of-order or duplicate steps,
over-limit input, cancelling a settled task — are rejected with
`INVALID_MODEL`.

## Usage

```sh
node cli.js model  --seed 7 --accounts 3 --tasks 8
node cli.js replay --seed 7 --accounts 3 --tasks 8
```

`model` prints the seed, the generated task pool (each task carries its PRNG
sampling index `draw`), the safety verdict, the lexicographically shortest
violating sequence (`none` when safe), an enumeration certificate with the
exact schedule count, and a SHA-256 state hash. `replay` rebuilds the same
pool and search result from the same arguments and verifies consistency.

## Testing

```sh
node --test
```

The suite cross-checks the memoized enumerator against an independent
full-permutation enumerator for pools of up to 3 tasks, verifies that seed 7
covers freeze/debit competition, and checks all `INVALID_MODEL` rejections.
