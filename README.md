# Linearizable Payment History

Offline library + CLI (Node.js 22, standard library only) that takes payment
requests (`refund` / `void` / `unfreeze`) arriving out of order and decides a
linearizable commit history: every request is assigned a commit slot,
happens-before relations are propagated, and a backtracking search picks the
replay slots. Unserializable inputs report a conflict cycle.

## CLI

```
node . history input.json output.json
```

Exit codes: `0` success, `1` unknown order / illegal amount / malformed input,
`2` usage error.

## Input

```json
{
  "orders": [{ "orderId": "o1", "charged": 1000, "frozen": 500 }],
  "requests": [
    { "id": "u1", "type": "unfreeze", "orderId": "o1", "amount": 500, "key": "k-u", "arrival": 1 },
    { "id": "r1", "type": "refund",   "orderId": "o1", "amount": 300, "key": "k-r", "arrival": 2 },
    { "id": "v1", "type": "void",     "orderId": "o1", "key": "k-v", "arrival": 3 }
  ]
}
```

- `arrival` is the arrival order (defaults to array position).
- `key` is the idempotency key (defaults to `id`); a repeated key replays the
  first result (`replayOf`) without consuming a commit slot.
- `after: ["id"]` declares an explicit happens-before edge to another request.

## Rules

- A refund never exceeds the refundable balance (`charged - refunded so far`).
- After a void commits, no new refund may commit (earlier refunds stay valid).
- An unfreeze commits only after a successful void of the same order.
- Same idempotency key replays the same result.
- Refund exceeding the charged total (or unfreeze exceeding the frozen total)
  is `UNSAT`; insufficient budget at commit time is `PENDING`, not `UNSAT`.
- A refund blocked by a committed void is `REJECTED`.

## Output

```json
{
  "status": "OK | UNSAT",
  "commitOrder": ["r1", "v1", "u1"],
  "requests": [{ "id": "...", "status": "COMMITTED|PENDING|REJECTED|UNSAT", "slot": 0, "reason": null }],
  "balances": [{ "slot": 0, "requestId": "r1", "refunded": 300, "refundable": 700, "frozenRemaining": 500, "voided": false }],
  "conflictCycle": ["a", "b", "a"]
}
```

`conflictCycle` is `null` when the history is serializable.

## Tests

```
node --test
```

The solver is cross-validated against a brute-force permutation enumeration
(`lib/reference.js`) for all scenarios with up to 5 requests.
