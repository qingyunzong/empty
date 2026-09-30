# minidb

Mini transactional store in a state directory: base tables `R(A,K)`,
`S(K,B)` and a join-count view grouped by `A` (number of `(R,S)` pairs
with `R.K = S.K` per `A`). Pure Python 3.11 standard library.

## Usage

```sh
python3 minidb.py apply tx.json --state STATE_DIR [--fail pre_commit|post_commit|post_checkpoint]
python3 minidb.py recover --state STATE_DIR
```

`tx.json` example:

```json
{"ops": [
  {"op": "insert", "table": "R", "a": "a1", "k": "k1"},
  {"op": "insert", "table": "S", "k": "k1", "b": "b1"},
  {"op": "delete", "table": "R", "a": "a1", "k": "k1"}
]}
```

## Semantics

- Every WAL record is fsync'd before the next step; base tables change
  only via checkpoint (`tables.json` written atomically, then a
  `CHECKPOINT` record, then WAL truncation).
- `pre_commit` crash (before the `COMMIT` record): recovery rolls the
  transaction back completely.
- `post_commit` crash (after `COMMIT` fsync, before checkpoint):
  recovery redoes the transaction and the view is consistent.
- `post_checkpoint` crash (after checkpoint fsync): the transaction is
  durable; recovery does not re-apply it (txid guard makes redo
  idempotent).
- Semantic errors (duplicate insert, missing delete target, unknown
  table/op, missing field, malformed file) exit with code 2, write no
  `COMMIT`, and leave committed state untouched. Simulated crashes exit
  with code 137.

## Tests

```sh
python3.11 -m unittest test_minidb -v
```

The acceptance tests recover from all three failure points and verify
the stored view against an independent nested-loop recomputation from
the committed base tables.
