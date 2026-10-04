# Multilateral Settlement

Offline multilateral bank settlement library and CLI. Node.js 22, standard
library only, tests via `node:test`.

## Usage

```
node . settle input.json output.json
```

Exit code `1` on malformed input or references to unknown entities (accounts,
instructions, illegal revocations). Exit code `0` otherwise, including
`UNSAT` and `PENDING`, which are marked in the output (`status` field).
`PENDING` (backtrack budget exhausted) is never reported as `UNSAT`.

## Input

```json
{
  "accounts": [{ "id": "A", "limit": 100 }],
  "instructions": [{ "id": "p1", "from": "A", "to": "B", "amount": 50, "frozen": 0 }],
  "revocations": [{ "id": "r1", "instruction": "p1", "time": "2026-01-01T00:00:00Z" }],
  "budget": 100000
}
```

- `limit`: maximum total freeze per account.
- `frozen`: prior freeze still held; revocations release it in reverse
  chronological order (sequence numbers recorded in the certificate).
- `budget`: maximum number of backtracks before the solver returns `PENDING`.

## Model

Each instruction is disposed as `FULL` (freeze full amount), `NET`
(bilateral netting against opposite-direction `NET` instructions between the
same account pair), or `SUSPEND` (no freeze; pending reasons are listed).
Revoked instructions never produce new freezes. Per-account freezes never
exceed the available limit.

The solver performs finite-domain propagation (netting support, limit lower
bounds, value pruning), chronological backtracking with a budget, and
conflict explanation. The certificate contains the decision log,
post-propagation domains, freeze totals, revocation sequence numbers,
backtrack count, and a minimal conflict set.

## Tests

```
node --test
```

Tests cross-check the solver against exhaustive enumeration of all
dispositions for instances with at most three accounts.
