# quota-freeze-model-checker

Randomized state-verification library and CLI for a two-phase quota
freeze/debit task model, built on the Node.js 22 standard library and
`node:test` only (no dependencies, no `Math.random`).

## Model

Each account has a `limit`, plus `used` and `frozen` balances. The safety
invariant under verification is:

    used + frozen <= limit        (for every account, in every reachable state)

Every task is a participant with two ordered steps, `reserve` then `complete`;
steps of different tasks interleave arbitrarily:

| task               | reserve                                            | complete                          |
|--------------------|----------------------------------------------------|-----------------------------------|
| `freeze(amount)`   | `frozen += amount`                                 | no balance change                 |
| `unfreeze(target)` | cancels a *reserved* freeze: `frozen -= amount`    | no balance change                 |
| `debit(amount)`    | `frozen += amount`                                 | `frozen -= amount`, `used += amount` |
| `cancelDebit(t)`   | cancels a *reserved* debit: `frozen -= amount`     | no balance change                 |

Reserve steps deliberately do **not** pre-check the limit: the checker
verifies whether a generated task pool can overcommit quota under some
interleaving, and exhibits the shortest (then lexicographically smallest)
violating step sequence. A *legal schedule* is a maximal feasible step
sequence (lifecycle guards such as "unfreeze only cancels an incomplete
freeze" prune infeasible branches).

Invalid pools are rejected with `INVALID_MODEL`: unknown task/kind/account,
duplicate task ids, duplicate completion (two cancellers for one target),
cross-account cancellation, and over-limit or non-positive amounts.

## Determinism

All randomness comes from a SplitMix64 PRNG (`src/prng.js`) seeded with
`--seed`. Every draw increments a recorded sampling index (`seq`), and any
`(seed, seq)` pair can be resumed in O(1), so `replay` rebuilds the identical
task pool and search results.

## Usage

```sh
node cli.js model  --seed 7 --accounts 3 --tasks 8 [--json]
node cli.js replay --seed 7 --accounts 3 --tasks 8 [--expect-hash <hex>] [--json]
node cli.js check  --pool pool.json [--json]
```

`model` prints the seed, the generated task pool, the safety verdict, the
enumeration certificate (when every legal schedule is safe) or the
lexicographically shortest violating sequence, and a SHA-256 state hash over
the canonical pool + summary. `replay` reconstructs the same pool and search
results and verifies the hash. `check` validates and analyzes an explicit
pool file (exit code 1 with `INVALID_MODEL` on rejection).

## Verification

- `src/enumerate.js` — memoized DFS over the task-status state graph counts
  every legal schedule exactly; a level-synchronous BFS yields the shortest,
  lexicographically smallest violation.
- `src/brute.js` — an independent full-permutation enumerator used to
  cross-check the main enumerator on pools of at most 3 tasks.

## Tests

```sh
node --test
```
