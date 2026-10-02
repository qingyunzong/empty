# paylimit-fuzz

Deterministic payment-limit stress-testing library and CLI (Node.js 22, stdlib only).

## Model

- Each account has `balance`, `held` (reserved limit) and a `frozen` flag.
- `reserve` holds limit (`held += amount`); rejected when the account is frozen
  (`ACCOUNT_FROZEN`) or `amount > balance - held` (`INSUFFICIENT_FUNDS`).
- `settle` deducts both `held` and `balance`; only valid while the reservation is `open`.
- `cancel` restores the held limit; only valid before `settle`. A `cancel` arriving
  after `settle` is rejected as a race (`RACE_ALREADY_SETTLED`).
- Rejected ops never mutate state (checks precede any mutation).

## Determinism

All randomness comes from an explicit mulberry32 PRNG (`src/rng.js`) seeded with
`--seed`. `Math.random` and `Date` are never used (enforced by tests). Every random
integer draw is logged with its purpose, sequence number and value; every op logs its
sequence, id, parameters and result. State hashes are SHA-256 over a canonical
(key-sorted) JSON serialization.

## Usage

```sh
node cli.js fuzz --seed 42 --steps 80 --accounts 3 --out run.json
node cli.js replay run.json   # exits 0 with REPLAY_OK on exact match
```

`replay` regenerates the run from the seed, re-applies the recorded ops to a fresh
ledger, and compares state hash, per-op results and the random sample sequence.
Invalid input (bad seed, negative steps, unknown op, unknown command) exits with
code 1 and an `INVALID_INPUT` message.

## Tests

```sh
node --test
```

Includes an independent exhaustive interleaving enumerator (`src/enumerator.js`)
that cross-checks the engine's final state for all plans of <= 4 steps across all
permutations of the generated ops.
