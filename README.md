# offline-equipment-award

Offline, single-machine equipment combination selection. Pure Node.js 22
standard library; tests use `node:test`.

## Data model

A data directory holds four JSON files:

- `orders.json`: `[{ "order", "process" }]` — processes required by an order
- `machines.json`: `[{ "machine", "process", "cert_expiry" }]` — `cert_expiry: null` means **no valid certificate**; a null certificate never passes any qualification
- `costs.json`: `[{ "machine", "shift_cost" }]`
- `budget.json`: `{ "budget": <number> }` (total budget for summed shift costs)

## Selection semantics

1. **Relational division** (`candidates`): keep only machines holding a valid
   (non-null) certificate for at least one required process.
2. **Award** (`award`): among combinations covering *all* required processes
   with total cost within budget, pick by cascading keys:
   fewer machines → lower total cost → lexicographic order of sorted machine ids.
   Machine count is the primary key so that a budget decrease can invalidate an
   award in favour of a cheaper, larger backup combination.
3. **Incremental change** (`apply-change`): events arrive as JSON —
   `{"type":"revoke-cert","machine":"M1"[,"process":"P1"]}` and
   `{"type":"budget","budget":N}`. The previous assignment is withdrawn, the
   award is recomputed, and the result carries the old→new diff plus the
   reassignment certificate. If no combination fits, the result is
   `infeasible` with a minimal `missing_capability` / `budget` certificate —
   never `pending`.

## CLI

```sh
node cli.js candidates   --data examples/data --order O1
node cli.js award        --data examples/data --order O1
node cli.js apply-change --data examples/data --order O1 \
  --event '{"type":"budget","budget":7}'
```

## Library

`src/lib.js` exports `candidates`, `award`, `applyChange`, `applyEvent`,
`compareSolutions`, `requiredProcesses`, `qualifiedCapabilities`.
`src/reference.js` independently enumerates **all** subsets (≤ 12 machines) as
a reference; `test/reference.test.js` cross-checks it against the main
branch-and-bound on hundreds of random instances.

## Tests

```sh
node --test
```
