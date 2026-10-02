# hold-linearizer

Linearizability checker and CLI for payment hold lifecycle histories, built on
the Node.js 22 standard library and `node:test` (no dependencies).

## Model

Operations: `hold`, `capture`, `cancel`, `audit`.

- `hold(amount, deadline)` freezes `amount` and returns a reservation id (`holdId`).
- `capture(holdId, amount)` may capture once or many times before the deadline;
  the total captured never exceeds the held amount. The response field
  `captured` is the total captured on the hold observed at response time, so
  the checker chooses an allocation keeping the running total `<= captured`.
- `cancel(holdId)` releases the remaining frozen amount (`frozen = 0`,
  `captured` kept, `available = 0`).
- `audit(holdId)` observes `{frozen, captured, available}`; `available` is the
  still-capturable remainder.

A history is linearizable when there is an ordering of its <= 12 operations
that respects real time (A before B whenever `A.respond <= B.invoke`), assigns
each operation a linearization point inside its `[invoke, respond]` interval,
and satisfies the sequential semantics above.

## History format

```json
{
  "operations": [
    {"id": "h1", "op": "hold", "holdId": "H1", "amount": 100, "deadline": 50,
     "invoke": 0, "respond": 2, "clock": 1, "version": 1},
    {"id": "c1", "op": "capture", "holdId": "H1", "amount": 30, "captured": 30,
     "invoke": 3, "respond": 5, "clock": 2, "version": 1},
    {"id": "x1", "op": "cancel", "holdId": "H1",
     "invoke": 6, "respond": 8, "clock": 3, "version": 1},
    {"id": "a1", "op": "audit", "holdId": "H1",
     "result": {"frozen": 0, "captured": 30, "available": 0},
     "invoke": 9, "respond": 10, "clock": 4, "version": 1}
  ]
}
```

`INVALID_HISTORY` is reported for malformed input, negative capture amounts,
unknown/duplicate hold ids, and expired requests (a capture invoked after its
hold's deadline).

## CLI

```
node cli.js linearize history.json
```

Output (JSON on stdout):

- `{"status": "LINEARIZABLE", "witness": [...], "audits": [...]}` — exit 0.
  The witness lists each operation with its linearization point and, for
  captures, the allocated increment; `audits` lists the values each audit saw.
- `{"status": "NOT_LINEARIZABLE", "conflict": [...]}` — exit 1. `conflict` is
  a minimum-size set of operation ids whose sub-history is not linearizable.
- `{"status": "INVALID_HISTORY", "errors": [...]}` — exit 2.
- Usage errors — exit 3.

## Library

- `src/linearize.js` — `linearize(history)`, `findWitness(history)`,
  `findMinimalConflict(history)`.
- `src/validate.js` — `validateHistory(history)`, throws `InvalidHistoryError`.
- `src/enumerator.js` — independent brute-force enumerator (<= 6 operations)
  used to cross-validate every witness strategy of the main checker.

## Tests

```
node --test
```

Covers the three acceptance scenarios (overlapping audit reading any legal
intermediate state, capture-after-cancel rejected, partial capture then cancel
releasing only the remainder), CLI exit codes, and 400 randomized small
histories cross-checked between the checker and the independent enumerator.
