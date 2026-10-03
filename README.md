# shared-credit-auth

Offline shared-credit authorization engine and CLI. Node.js 22, standard library
only, tested with `node:test`. No dependencies.

Supplementary cards share the primary credit line. An authorization can only be
approved in full, approved partially at a preset tier, or declined. Reversals
restore capacity according to authorization history.

## Usage

```sh
node . auth input.json output.json
node --test
```

Exit codes: `0` success, `1` input/domain error (unknown card, unknown
authorization, reversal exceeding the remaining approved amount, malformed
input), `2` usage error.

## Input

```json
{
  "sharedLimit": 1000,
  "budget": 10000,
  "tiers": [1, 0.5, 0.25],
  "cards": { "A": { "limit": 600 }, "B": { "limit": 500 } },
  "categoryLimits": { "dining": 800 },
  "operations": [
    { "type": "auth", "id": "a1", "card": "A", "amount": 400, "category": "dining" },
    { "type": "auth", "requests": [ { "id": "a2", "card": "B", "amount": 700 } ] },
    { "type": "reverse", "authId": "a1", "amount": 100 }
  ]
}
```

- `sharedLimit` (required): primary credit line shared by all cards.
- `cards` (required): per-card limits (card layer).
- `categoryLimits` (optional): per-merchant-category limits (category layer).
- `tiers` (optional, default `[1, 0.5, 0.25]`): preset partial-approval tiers as
  fractions of the requested amount; full amount is always a candidate.
- `budget` (optional, default `10000`): solver node budget.
- `operations`: `auth` (single request or `requests` batch, optional
  `required: true` to forbid declining) and `reverse` (`amount` optional,
  defaults to the remaining approved amount).

## Semantics

- Layers: shared + per-card + per-category (when configured). An approval must
  satisfy every layer it touches simultaneously.
- Unsettled (approved, not yet reversed) authorizations count toward occupancy
  on every layer, including same-card occupancy.
- Reversals restore every layer the authorization touched, may be partial, are
  bounded by the remaining approved amount, and release waiting authorizations
  (retried in FIFO order, joint tier search).
- Partial approvals report `pendingDiff` (requested − approved).
- Solver: depth-first tier enumeration with capacity propagation (pruning) and
  backtracking over ≤3-card batches. Budget exhausted → `PENDING`; only a fully
  enumerated search with no feasible assignment → `UNSAT`.
- Conflicts are explained by `conflictCards`: cards whose required minimum tier
  is blocked plus cards holding active freezes in the blocking layers.

## Output

```json
{
  "status": "OK | PENDING | UNSAT",
  "decisions": [
    { "seq": 1, "id": "a1", "card": "A", "category": "dining", "requested": 400,
      "approved": 400, "pendingDiff": 0, "status": "APPROVED | PARTIAL | DECLINED | PENDING" }
  ],
  "freezes": {
    "shared": { "used": 0, "limit": 1000, "remaining": 1000 },
    "cards": { "A": { "used": 0, "limit": 600, "remaining": 600 } },
    "categories": { "dining": { "used": 0, "limit": 800, "remaining": 800 } }
  },
  "reversals": [
    { "authId": "a1", "restored": 100, "remainingApproved": 300, "releasedApprovals": ["a2"] }
  ],
  "conflictCards": [],
  "waiting": []
}
```

## Layout

- `index.js` — CLI entry (`node . auth input.json output.json`)
- `src/cli.js` — argument parsing, IO, exit codes
- `src/engine.js` — account state, layers, auth/reverse processing, waitlist, conflict explanation
- `src/solver.js` — tier enumeration, propagation, backtracking, node budget
- `test/` — acceptance scenarios (shared-limit partial approval, reversal
  releasing a waiting order, layer-conflict UNSAT, budget PENDING) plus unit
  and CLI tests
