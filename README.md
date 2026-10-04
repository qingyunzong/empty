# multilateral-settlement

Offline multilateral bank settlement library and CLI. Node.js 22, standard
library only, tests use `node:test`. No dependencies, no network access.

## Usage

```
node . settle input.json output.json
```

- Exit code `1`: malformed JSON, schema violations, or references to
  nonexistent entities (accounts, instructions, illegal revocations).
  Nothing is written to the output file.
- Exit code `0`: the solver ran; the output file records `SETTLED`,
  `UNSAT`, or `PENDING` (backtrack budget exhausted — never conflated
  with `UNSAT`).

## Input

```json
{
  "accounts": [{ "id": "A", "limit": 100 }],
  "instructions": [
    { "id": "I1", "from": "A", "to": "B", "amount": 60, "mandatory": false }
  ],
  "revocations": [{ "seq": 1, "instruction": "I1" }],
  "budget": 1000000,
  "previous": { "dispositions": { "I1": "FULL" } }
}
```

- `accounts[].limit`: maximum total freeze per account (non-negative).
- `instructions[].mandatory`: if `true`, the instruction may not pend.
- `revocations[]`: `seq` is a unique positive integer (time order);
  `instruction` must exist and may be revoked at most once. Revocations
  release the original freezes newest-first (reverse time order); a revoked
  instruction must not produce a new freeze.
- `budget`: maximum number of backtracks (default 1,000,000). Exhaustion
  yields `PENDING`.
- `previous`: optional prior plan used to compute released freeze amounts
  and the incremental `changes` of the new plan.

## Dispositions

- `FULL`: freeze the full amount on the payer account.
- `NET`: only valid between bidirectional instructions; per account pair the
  payer freezes `max(0, out(a->b) - out(b->a))`.
- `PEND`: no freeze; the output lists the unresolved reasons
  (`REVOKED`, `INSUFFICIENT_LIMIT`, `NO_NETTING_PARTNER`, `UNRESOLVED`).

## Output

`status`, per-instruction `dispositions` (with `reasons` when pended),
per-account `freezes`, and a `certificate` containing:

- `decisions`: search decisions on the solution/conflict path,
- `domainsAfterPropagation`: finite domains after root propagation,
- `freezes`: total freeze per account,
- `revocations`: applied revocations in reverse time order with released
  amounts,
- `backtracks` / `budget`: backtracking statistics,
- `conflict`: kind, involved instructions (minimal conflict set), and a
  human-readable explanation (`null` when settled),
- `changes`: disposition deltas versus `previous` (when provided).

## Solver

Finite-domain CSP: per-instruction domains over `{FULL, NET, PEND}`,
fixpoint propagation (netting-pair consistency + sound per-account freeze
lower bounds), depth-first backtracking with a backtrack budget, and
conflict explanation with minimal (irreducible) conflict sets.

## Tests

```
node --test
```

The suite cross-checks the solver against exhaustive enumeration of all
`3^n` disposition assignments on random problems with at most 3 accounts
and 5 instructions (`test/enumeration.test.js`), covers the acceptance
scenarios (`test/acceptance.test.js`), and exercises the CLI contract
in-process (`test/cli.test.js`).
