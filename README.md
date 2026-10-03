# kitting-allocator

Offline, single-machine kitting allocation library and CLI. Node.js 22,
standard library only (`node:test` for tests). No dependencies.

## Model

- **Batches**: `{ id, material, qty, expiry, status }` with `status` `"OK"` or
  `"HOLD"`. Only `OK`, non-expired (`expiry >= now`, when `now` is set) stock
  can be reserved.
- **Substitutes**: directed edges `[fromMaterial, toMaterial]` meaning "a line
  requiring `fromMaterial` may be fulfilled by stock of `toMaterial`".
  Eligibility is the reflexive transitive closure; the graph must remain
  acyclic (`CYCLE` error otherwise).
- **Orders**: `{ id, due, lines: [{ line, material, qty }] }`.

## Allocation semantics

- **Reservation order**: orders sorted by `(due, id)`, lines by `line`.
- **FEFO**: within a line, eligible batches are consumed in `(expiry, id)`
  order, one unit at a time.
- The greedy result equals the lexicographic optimum over all feasible
  unit-level matchings under the objective: per line in reservation order,
  maximize fill, then minimize the sorted `(expiry, batchId)` consumption
  vector. `test/reference.test.js` verifies this against an independent
  brute-force matcher.
- **Invalidation propagation**: derived data (reservations, shortages,
  certificates) is never patched in place. Every successful command pushes a
  new immutable state snapshot and the allocation is recomputed
  deterministically, so a freeze/release/order/substitute change propagates
  to all dependent reservations. Earlier orders (by reservation order) are
  never preempted by later ones.
- **HOLD handling**: when stock is frozen, a line first shifts onto its
  remaining eligible batches (including substitutes); only if the line can no
  longer be filled is its order marked `SHORT`, with a certificate listing
  the missing quantities and every substitute material that was tried (with
  the stock that was available at that point).

## CLI

```
node src/cli.js kit input.json commands.json -o out.json
```

Without `-o`, the result is written to stdout. Exit codes: `0` success
(command-level errors are reported in `log` and do not change the exit code),
`1` unreadable/invalid input or commands file, `2` usage error.

### input.json

```json
{
  "now": "2026-01-01",
  "substitutes": [["M1", "M2"]],
  "batches": [{ "id": "B1", "material": "M1", "qty": 5, "expiry": "2026-02-01", "status": "OK" }],
  "orders": [{ "id": "O1", "due": "2026-01-10", "lines": [{ "line": 1, "material": "M1", "qty": 3 }] }]
}
```

`now` is optional; `status` defaults to `"OK"`. Dates/ids may be strings
(ISO-8601 recommended, compared lexicographically) or numbers.

### commands.json

An array of commands, applied in order:

| op | fields | effect |
| --- | --- | --- |
| `addOrder` | `order` | add order (`DUPLICATE` if id exists) |
| `removeOrder` | `orderId` | remove order (`UNKNOWN_ORDER`) |
| `addBatch` | `batch` | add batch (`DUPLICATE` if id exists) |
| `removeBatch` | `batchId` | remove batch (`UNKNOWN_BATCH`) |
| `consumeBatch` | `batchId`, `qty` | deduct stock (`OVER_DEDUCTION` if `qty` exceeds on-hand) |
| `freezeBatch` | `batchId` | set `HOLD` (`UNKNOWN_BATCH`) |
| `releaseBatch` | `batchId` | set `OK` (`UNKNOWN_BATCH`) |
| `addSubstitute` | `from`, `to` | add edge (`CYCLE` if it closes a cycle) |
| `removeSubstitute` | `from`, `to` | remove edge (`UNKNOWN_SUBSTITUTE`) |
| `undo` | — | revert the last successful mutation (`UNDO_EMPTY`) |
| `redo` | — | reapply an undone mutation (`REDO_EMPTY`); a new mutation clears the redo stack |

Failed commands leave the state untouched and are recorded in the output
`log` with `ok: false`, a `code` and an `error` message.

### out.json

```json
{
  "log": [{ "index": 0, "op": "freezeBatch", "ok": true }],
  "state": {
    "now": null,
    "reservations": [{ "orderId": "O1", "line": 1, "batchId": "B1", "material": "M1", "batchMaterial": "M1", "qty": 3, "expiry": "2026-02-01" }],
    "orders": [{ "orderId": "O1", "due": "2026-01-10", "status": "COMPLETE", "lines": [ /* per-line required/reserved/short/allocations/attempted */ ], "certificate": null }],
    "batches": [{ "id": "B1", "material": "M1", "qty": 5, "expiry": "2026-02-01", "status": "OK", "reserved": 3, "available": 2 }],
    "substitutes": [["M1", "M2"]]
  }
}
```

For `SHORT` orders, `certificate` contains `missing` (per-line shortfalls)
and `attemptedSubstitutes` (every tried material with its available stock).

## Library

```js
const { Engine, allocate, createState } = require('./index');
const engine = new Engine(input);
engine.apply({ op: 'freezeBatch', batchId: 'B1' });
console.log(engine.result());   // same shape as out.json's "state"
```

## Tests

```
node --test                  # run the suite
npm run record-results       # regenerate test-results.txt (stdout, stderr, exit code)
```

`test-results.txt` records a real `node --test` run: stdout, stderr and the
exit code. See `examples/` for a runnable input/command pair.
