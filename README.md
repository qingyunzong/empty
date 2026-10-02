# settlement-batch-audit

Settlement batch audit library and CLI (Node.js 22, standard library only).
Checks invariants over command sequences mixing posts, reversal corrections
and limit freezes, and shrinks a failing batch to a minimal reproducible
counterexample.

## Commands

A plan is JSON: `{ "limits": { "<account>": <number> }, "commands": [...] }`.
Accounts without a configured limit are unlimited.

- `post(id, account, amount)` — books an amount; increases the account's
  posted total and occupies available limit. `id` must be unique.
- `cancel(postId)` — appends a reversal correction (negated amount) to the
  ledger; history is never deleted. Cancelling twice is a cyclic correction.
- `freeze(account, amount)` — reduces available limit by `amount`.

## Invariants

1. For every account: `posted + frozen <= limit` after every command.
2. Every correction amount has the opposite sign of its original post.
3. Cumulative totals are replayable: re-deriving state from the ledger
   alone reproduces the final state (deterministic replay hash).

Invalid commands (unknown/duplicate ids, cyclic corrections, negative or
zero amounts) are rejected with exit code 1 and an `INVALID_COMMAND` report.

## CLI

```
node cli.js shrink plan.json
```

- Safe plan: prints a certificate (final state, replay hash, audit ledger,
  and a check that deleting any single command keeps the plan safe),
  exit code 0.
- Unsafe plan: prints the shortest failing subsequence (ties broken by
  lexicographically smallest canonical form) with its final state, replay
  hash, violations and the removed commands, exit code 3. Minimality is
  established by exhaustive subset enumeration.
- Invalid plan: `INVALID_COMMAND` on stderr, exit code 1.

## Library

- `src/ledger.js` — validation, ledger replay, invariant checking, hashing.
- `src/shrink.js` — certificate generation and minimal-counterexample search.

## Tests

```
node --test
```

The suite covers the acceptance criteria and cross-checks the shrinker
against an independent brute-force oracle for every valid plan of up to
6 commands drawn from a small alphabet.
