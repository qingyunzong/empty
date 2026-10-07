# shared-limit-auth

Offline library and CLI for credit-card authorization on a shared primary
limit. Node.js 22, standard library only, tests via `node:test`.

## Model

- Supplementary cards share one primary (`sharedLimit`) credit limit; each
  card also has its own (`limit`). An authorization must satisfy **both**
  layers at once.
- Each authorization is approved **in full**, **partially at a preset tier**
  (`tiers`, fractions of the requested amount, e.g. `[1, 0.75, 0.5, 0.25]`),
  or left unapproved. No other amounts are possible.
- Approved (unsettled) authorizations freeze capacity: same-card pending
  authorizations count toward the card limit, all of them toward the shared
  limit.
- Reversals restore capacity per authorization history; a reversal may be
  partial but the cumulative reversed amount may never exceed the remaining
  approved amount.
- Partial approvals report the outstanding shortfall (`requested - approved`).

## Solving

`lib/solver.js` is a backtracking CSP solver:

- **Variables**: authorization requests (index 0 is the primary request;
  waiting orders are retried alongside it after a reversal, FIFO).
- **Domain**: preset tiers (descending) plus `0` (left waiting).
- **Propagation**: trial assignments are pruned against the remaining shared
  and per-card capacity.
- **Backtracking**: recursive search restores capacity on unwind.
- **Node budget**: every trial assignment counts one node. If the budget is
  exhausted before enumeration completes the result is `PENDING`; `UNSAT` is
  returned only after the full space is enumerated with no feasible tier.
- **Conflict explanation**: for `UNSAT`, each tier is annotated with the
  blocking layer (`card` / `shared` plus remaining capacity), and the
  conflict card set lists the blocking card and every card currently
  occupying the shared limit.

Unapproved requests (`UNSAT` / `PENDING`) enter a waiting queue and are
retried after every reversal, since restored capacity may make them feasible.

## CLI

```
node . auth input.json output.json
```

Exit code `1` (message on stderr, no output file) on: unknown card, unknown
authorization id, reversal exceeding the remaining approved amount, malformed
input, or bad arguments.

### Input

```json
{
  "sharedLimit": 1000,
  "budget": 100000,
  "tiers": [1, 0.75, 0.5, 0.25],
  "cards": [{ "id": "A", "limit": 600, "categories": ["dining"] }],
  "events": [
    { "type": "auth", "id": "r1", "card": "A", "amount": 600, "category": "dining" },
    { "type": "reversal", "auth": "r1", "amount": 200 }
  ]
}
```

`budget` and `tiers` are optional (defaults: `100000` nodes,
`[1, 0.75, 0.5, 0.25]`). `categories` is optional; an auth whose category is
not allowed by the card is `DECLINED` without search.

### Output

```json
{
  "decisions": [
    { "event": 0, "type": "auth", "id": "r1", "decision": "APPROVED_FULL",
      "approved": 600, "shortfall": 0, "tier": 1, "nodes": 1 }
  ],
  "freezes": { "shared": 600, "cards": { "A": 600 } },
  "restored": { "total": 0, "byAuth": {} },
  "waiting": [],
  "tiers": [1, 0.75, 0.5, 0.25],
  "budget": 100000
}
```

Auth decisions: `APPROVED_FULL`, `APPROVED_PARTIAL` (with `shortfall`),
`DECLINED` (category), `UNSAT` (with `conflictCards` and per-tier
`explanation`), `PENDING` (budget exhausted). Reversal records carry
`restored`, `remainingApproved` and a `retry` report with `placements` for
waiting orders approved by the released capacity.

## Tests

```
node --test
```

Covers the four acceptance scenarios: two cards partially approved under one
shared limit; reversal releasing capacity approves a waiting order;
card-layer limit conflict yields `UNSAT` with conflict cards; exhausted node
budget yields `PENDING`.
