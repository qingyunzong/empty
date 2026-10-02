# payhold-linearize

Linearizability checker and CLI for payment hold lifecycle histories
(`hold` / `capture` / `cancel` / `audit`), built on the Node.js 22 standard
library and `node:test`. No dependencies.

## Semantics

Each hold tracks `amount` (held), `captured` (cumulative), `active`, `deadline`.

- `hold(amount, deadline)` freezes `amount` and returns `holdId`.
- `capture(holdId, amount)` may capture one or more times before the
  deadline; the cumulative captured total never exceeds the held amount.
  The response reports `totalCaptured` (cumulative at response time); the
  checker chooses a capture allocation `<= amount` consistent with it.
- `cancel(holdId)` releases exactly the remaining hold (`amount - captured`).
- `audit(holdId)` observes `{ frozen, captured, available }`, where
  `frozen = available = active ? amount - captured : 0`.

## History format

```json
{
  "operations": [
    {
      "id": "c1", "op": "capture", "holdId": "H1",
      "invoke": 3, "respond": 5, "clock": 2, "version": 1,
      "amount": 30,
      "response": { "ok": true, "totalCaptured": 30 }
    }
  ]
}
```

Every operation carries `invoke`/`respond` wall-clock bounds, a logical
`clock`, a request `version`, and the observed `response`. Histories are
limited to 12 operations. Malformed fields, negative capture amounts, and
expired requests (a `capture`/`cancel` invoked after the hold's deadline)
are rejected as `INVALID_HISTORY`.

## Checker

`findWitnesses(ops)` enumerates candidate linearizations: permutations
preserving real-time order (`a.respond <= b.invoke` implies `a` before `b`),
with linearization points inside each `[invoke, respond]` interval (greedy
earliest-point assignment, which is componentwise minimal). For captures it
picks the allocation matching the reported cumulative total. If no witness
exists, `minimalConflict(ops)` computes a minimal (reference-closed)
non-linearizable subset. `src/brute.js` is an independent enumerator used to
cross-validate all witnesses on histories of up to 6 operations.

## CLI

```sh
node bin/linearize.js linearize history.json
```

- exit 0: `LINEARIZABLE` with a witness (order, linearization points,
  capture allocations, and the values visible to each audit)
- exit 1: `NOT_LINEARIZABLE` with a minimal conflict set of operation ids
- exit 2: `INVALID_HISTORY` with validation errors

## Tests

```sh
node --test
```
