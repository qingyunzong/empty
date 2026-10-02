# refund-ledger

Refund & revoke library (Node.js 22, standard library only) with hierarchical
rollback, merchant refund budgets and stable discount apportionment.

## Model

- All money is integer cents; tax rates are basis points (`taxRateBps`).
- An **order** has lines (`lineId`, `amount`, `taxRateBps`, `points`) and an
  order-level `discount` that is apportioned across lines.
- **Apportionment** is proportional by line amount; remainder cents are
  distributed one at a time in `lineId` lexicographic order, so ties (same
  amount, same tax) always resolve identically regardless of input order.
- A **refund** of a line claws back its discount share, its tax on the
  discounted net, and its loyalty points.
- **Settlement**: a refund is settled when `asOf >= date + settleDays`
  (default `settleDays: 1`). Settled refunds cannot be revoked; revoking one
  reports `E_ALREADY_SETTLED` and can optionally emit a **reversal**
  (counter-refund with negated amounts, linked via `parentRefId`).

## Hierarchical rollback

Refunds on the same order share the order-level discount pool and points
ledger, so a later refund depends on every earlier active refund of that
order. `revoke(refId)` rolls back the whole descendant subtree, children
first. If any node in the subtree cannot be rolled back (e.g. it is already
settled), the entire subtree is left untouched and `E_ROLLBACK_PATH` is
returned with the failing `path`.

## Budget

Per-merchant refund budgets aggregate refund totals per period
(`monthly` / `daily` / `yearly` / `none`). A refund that would exceed the
limit is rejected with `E_BUDGET_EXCEEDED` before any state changes — never
partially deducted. Revokes and reversals release budget.

## Library

```js
import { RefundLedger } from './src/index.js';

const ledger = new RefundLedger({ asOf: '2026-02-01' });
ledger.setBudget('m1', { limit: 100000, period: 'monthly' });
ledger.refund('r1', order, ['a'], { date: '2026-01-10', settleDays: 7 });
ledger.revoke('r1');                    // hierarchical rollback
ledger.revoke('r2', { reverse: true }); // settled -> optional reversal
```

All operations return `{ ok: true, record }` or
`{ ok: false, error: { code, message, ... }, reversal? }`.

## CLI

```
refund apply ops.jsonl --as-of 2026-02-01
# or: node src/cli.js apply ops.jsonl --as-of 2026-02-01
```

`ops.jsonl` holds one JSON op per line (`#` comments and blanks ignored):

```jsonl
{"op":"budget","merchantId":"m1","limit":100000,"period":"monthly"}
{"op":"refund","refId":"r1","date":"2026-01-05","settleDays":1,"order":{...},"lines":["a"]}
{"op":"revoke","refId":"r1","reverse":true}
```

Result records are printed to stdout as JSONL. On the first failing op the
CLI prints `{"code","message"}` to stderr and exits non-zero (a settled
revoke with `reverse: true` still emits its reversal record to stdout first).
See `ops.example.jsonl`.

## Errors

`E_USAGE` `E_IO` `E_INVALID_OP` `E_INVALID_DATE` `E_DUPLICATE_REF`
`E_UNKNOWN_LINES` `E_LINE_ALREADY_REFUNDED` `E_BUDGET_EXCEEDED`
`E_NOT_FOUND` `E_ALREADY_REVOKED` `E_ALREADY_REVERSED` `E_ALREADY_SETTLED`
`E_ROLLBACK_PATH`

## Tests

```
node --test
```
