# miniopt

Single-machine, offline query engine with a cost-based optimizer. Node.js 22
standard library only; tests use `node:test`.

## Query JSON

```json
{
  "scan": "users",
  "joins": [
    { "type": "inner", "table": "orders", "on": [["users.id", "orders.user_id"]] },
    { "type": "left",  "table": "profiles", "on": [["users.id", "profiles.user_id"]] }
  ],
  "filter": [{ "col": "users.age", "op": ">=", "value": 18 }],
  "groupBy": {
    "keys": ["users.dept"],
    "aggregates": [{ "fn": "count", "col": "*", "as": "n" }]
  }
}
```

- Operators: `= != < <= > >=` (or `eq neq lt lte gt gte`).
- Aggregates: `count sum avg min max`; `count(*)` counts rows, `count(col)`
  skips nulls; other aggregates ignore nulls. Nested aggregates are illegal.
- Column references must be `table.column` and exist in the catalog.

## Catalog JSON

```json
{
  "tables": {
    "users": {
      "rowCount": 1000, "pages": 50,
      "columns": { "id": {}, "age": { "selectivity": 0.3 } },
      "indexes": [{ "name": "users_age_idx", "columns": ["age"], "selectivity": 0.3, "pages": 5 }]
    }
  },
  "joinSelectivity": { "orders.user_id=users.id": 0.001 }
}
```

`joinSelectivity` keys are the two qualified columns, sorted, joined by `=`.

## Cost model

`cost = scanned pages + join intermediate result rows`

- SeqScan: `pages` from the catalog. IndexScan: `index.pages + ceil(pages * index.selectivity)`.
- Filter selectivity comes from the column's catalog `selectivity` (default 0.5).
- Inner join output: `L * R * joinSelectivity` (default 0.1 per condition pair).
- Left join output: `max(L, L * R * joinSelectivity)` (null padding keeps left rows).

## Optimizer

For up to 5 tables it enumerates every legal plan — all binary join orders
(bushy trees), all correlated predicate pushdown positions, and all index
scan choices — evaluates each with the cost model, and keeps the cheapest;
ties go to the lexicographically smallest plan string.

- Inner joins reorder freely; cross products are never considered.
- A left join's null-supplying table stays the lone right child of its left
  join, with every earlier table on the left side, so null padding is
  preserved. A predicate referencing a padded column is only legal at or
  above that left join — it is never pushed into the padded scan and the
  join is never rewritten to an inner join.
- Join conditions match only non-null values; `GROUP BY` treats null as its
  own group.

## Plan cache and statistics

`Engine` caches one plan per distinct query. `updateStats(table, stats)`
merges new statistics into the catalog and invalidates only cached plans
that reference that table, returning for each affected query the old/new
plan, old/new cost, and the result-hash delta (sha256 of the normalized
result rows before vs. after).

## CLI

```
node cli.js explain      --catalog C.json --query Q.json [--data D.json]
node cli.js execute      --catalog C.json --data D.json --query Q.json
node cli.js update-stats --catalog C.json --data D.json --query Q.json --table T --stats S.json
```

Illegal queries (unknown table/column, nested aggregate, ...) print
`error: <message>` to stderr and exit with code 1.

## Tests

```
node --test
```

`npm run result` regenerates `result.txt` with the real CLI output of the
three acceptance scenarios in `examples/`.
