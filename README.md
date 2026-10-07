# mvview — incremental bag-semantics join + group-by materialized view

Pure Python 3.11 standard library. Maintains an equi-join of two bag tables
plus a per-group aggregate view under batch updates, with WAL/checkpoint
crash recovery and full batch atomicity.

## Data model

- Left table `L(id UNIQUE, cid, value)` — transactions.
- Right table `R(cid, group)` — bag with multiplicity (duplicate rows
  amplify join contributions by their multiplicity).
- `NULL` (`null`) join keys never match; `null` values count in `COUNT(*)`
  but are excluded from `SUM` and the median.

Per group the view maintains `COUNT(*)`, `SUM` (exact `Fraction`), the exact
rational median, and rank queries, backed by a deletable order-statistics
AVL tree (`mvview/orderstats.py`) — history is never re-sorted per update.

## Batch maintenance

`Engine.apply_batch` validates the whole batch first (unique-id conflicts,
out-of-range deletes/retracts, conflicting ops) and only then mutates, so
illegal batches leave tables, indexes, order statistics and the output
cursor untouched. View deltas use the delta join rule

    Δ(L ⋈ R) = ΔL ⋈ R_old + L_old ⋈ ΔR + ΔL ⋈ ΔR   (cross term included)

Batch fields (all optional, applied atomically):

    {
      "left_insert":  [{"id": 1, "cid": "a", "value": 10}],
      "left_retract": [2],
      "left_replace": [{"id": 3, "cid": "b", "value": "7/2"}],
      "right_insert":  [{"cid": "a", "group": "g1", "count": 2}],
      "right_retract": [{"cid": "b", "group": "g2", "count": 1}],
      "migrate":       [{"cid": "a", "from": "g1", "to": "g2", "count": 1}]
    }

## Recovery

`Storage` appends every committed batch to `wal.jsonl` (batch + commit
records, fsynced) and can snapshot `checkpoint.json`. `Storage.recover`
loads the newest checkpoint, then replays only committed batches with ids
newer than the checkpoint — committed batches are never double-counted and
an uncommitted log tail (crash mid-batch) is ignored.

## CLI

JSON-lines on stdin/stdout:

    python3.11 -m mvview --dir /tmp/mvstate
    {"cmd": "batch", "left_insert": [{"id": 1, "cid": "a", "value": 4}], "right_insert": [{"cid": "a", "group": "g"}]}
    {"cmd": "view"}
    {"cmd": "median", "group": "g"}
    {"cmd": "rank", "group": "g", "value": 4}
    {"cmd": "checkpoint"}

Commands: `batch`, `view`, `median`, `rank`, `outputs`, `checkpoint`,
`recover`. With `--dir`, committed state is recovered automatically on start.

## Tests

    python3.11 -m unittest discover -s tests -v

Includes randomized batch-by-batch comparison (≤5 customers, ≤12
transactions) against an independent join-then-sort reference model,
same-batch two-table churn, group migration, median odd/even switching,
all-NULL groups, recovery replay, uncommitted log tails, and full atomicity
of illegal batches.
