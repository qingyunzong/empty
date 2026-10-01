# mvview — incremental equi-join group-by materialized view

Pure Python 3.11 (standard library only). Maintains a materialized view
over the natural join of two bag tables, incrementally, with exact
rational aggregates, atomic batches, and WAL/checkpoint recovery.

## Data model

- **Left table** `txid -> (customer, value)`: transactions; `txid` is
  unique. `customer`/`value` may be `null`.
- **Right table** `(customer, group) -> multiplicity`: a bag; duplicate
  rows amplify each joined contribution by their multiplicity.
- **Join**: natural join on `customer`. `NULL` keys never match.
- **View**: per `group` — `COUNT(*)`, `SUM` over non-NULL values (exact
  rational, `null` when all values are NULL), exact rational **median**
  over non-NULL values, plus `rank(value)` / `select(k)` queries backed
  by an order-statistics AVL tree (insert/delete/select/rank in
  O(log n); history is never re-sorted).

## Batch maintenance

One batch may mix ops on both tables. The view delta uses the delta-join
rule including the same-batch cross term:

```
delta(L |x| R) = dL |x| R_old + L_old |x| dR + dL |x| dR
```

Batches are atomic: an unknown-txid retract, duplicate-txid insert,
over-retract of right rows, or an out-of-range migrate rolls back
everything — base tables, group statistics, order-statistics trees, the
published version cursor, and the WAL.

Ops (JSON):

```json
{"op": "insert_tx",    "txid": "t1", "customer": "c1", "value": 10}
{"op": "retract_tx",   "txid": "t1"}
{"op": "replace_tx",   "txid": "t1", "customer": "c2", "value": 5}
{"op": "insert_cust",  "customer": "c1", "group": "A", "count": 2}
{"op": "retract_cust", "customer": "c1", "group": "A", "count": 1}
{"op": "migrate",      "customer": "c1", "from": "A", "to": "B", "count": 1}
```

`migrate` moves `count` rows of `(customer, from)` to `(customer, to)`;
`"count": null` (or omitted) moves the full current multiplicity.
Numbers may be JSON ints, decimal strings/floats, `"p/q"` strings, or
`{"num": p, "den": q}` — all parsed as exact rationals.

## Persistence

- `wal.log`: one `begin` + one `commit` JSON record per committed batch,
  fsynced before the batch is visible.
- `checkpoint.json`: atomic (tmp + rename) snapshot of the base tables
  and the published version.
- Recovery loads the newest checkpoint, then replays only WAL batches
  with a matching `commit` and a batch id greater than the checkpoint
  version — committed batches are never counted twice, and an
  uncommitted or torn log tail is ignored.

## CLI

```
python3.11 -m mvview --state DIR apply ops.json     # or "-" for stdin
python3.11 -m mvview --state DIR view
python3.11 -m mvview --state DIR checkpoint
python3.11 -m mvview --state DIR recover
python3.11 -m mvview --state DIR rank GROUP VALUE
python3.11 -m mvview --state DIR select GROUP K
```

`apply` takes a JSON array of ops (or `{"ops": [...]}`) and applies it as
one atomic batch, printing `{"ok": true, "version": N}`; a rejected batch
prints `{"ok": false, "error": ...}` and exits 1.

## Library

```python
from mvview import Engine, BatchError

eng = Engine.open("state-dir")        # or Engine() for in-memory
eng.apply_batch([{"op": "insert_cust", "customer": "c1", "group": "A"},
                 {"op": "insert_tx", "txid": "t1", "customer": "c1",
                  "value": 10}])
eng.view()          # {"A": {"count": 1, "sum": Fraction(10), "median": ...}}
eng.rank("A", 5)    # number of non-NULL values < 5 in group A
eng.select("A", 0)  # smallest non-NULL value in group A
eng.checkpoint()
```

## Tests

```
python3.11 -m unittest discover -s tests -v
```

The suite checks the engine batch-by-batch against an independent
join-then-sort reference model (up to 5 customers / 12 transactions),
covering same-batch changes on both tables, group migration, median
odd/even transitions, all-NULL groups, duplicate-right-row multiplicity,
WAL replay, checkpoints, uncommitted log tails, and full rollback of
illegal batches.
