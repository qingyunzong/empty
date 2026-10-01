# bagra — incremental bag relational algebra

A small library (Python 3.11 standard library only) for report
subscriptions over continuously changing base tables.  Queries are
compiled once into a shared DAG of incremental operators; each committed
batch of changes pushes only the *deltas* (insertions / deletions of
result tuples) to subscribers — no full re-scans.

## Operators

`scan`, `filter`, `project`, `join`, `union_all`, `intersect_all`,
`except_all`, `distinct`.

Bag semantics throughout: relations map tuples to non-negative integer
multiplicities.  Input changes carry signed multiplicities; committed
base tables and all committed node multiplicities are always
non-negative (a violating batch raises `NegativeMultiplicityError` and
rolls the whole graph back).  `except_all` is `max(left - right, 0)` —
a right-heavier key floors at zero instead of erroring.

NULL (`None` / JSON `null`) follows SQL: it never matches in join keys
or comparisons, but is an ordinary value for set identity (`distinct`,
`project`, `intersect_all`, `except_all`).

## Incremental maintenance

Each compiled node keeps only the state its operator needs:

| node | state |
|---|---|
| `scan` | none (the committed base table) |
| `filter` / `project` / `union_all` | none (stateless) |
| `join` | key indexes over both committed inputs |
| `intersect_all` / `except_all` | committed multiplicities of both inputs |
| `distinct` | committed multiplicities of its input |

* join batch delta: `dL ⋈ R + L ⋈ dR + dL ⋈ dR` — the cross term covers
  both sides changing in the same batch (including self joins).
* `distinct` / `intersect_all` / `except_all` diff old vs. new
  thresholded values per changed key, emitting exactly on zero-threshold
  crossings.
* Structurally identical subexpressions are hash-consed into one node,
  so multiple outputs share subexpressions and each shared node is
  updated exactly once per batch.
* A batch is validated in full before any state is mutated; any error
  rolls the whole graph back — no publishes, no version bump.

## Subscriptions, publishing, recovery

* `Engine.add_subscription(id, plan)` publishes the current full result
  as insertion records at the current version, then only deltas.
  `Engine.remove_subscription(id)` detaches an output and
  garbage-collects unshared nodes.
* Publish records carry `version`, `subscription`, `seq`, `row`,
  `delta`; order is deterministic (subscription id, then canonical row
  order).
* `Engine.save(path)` / `Engine.load(path)` persist and recover version,
  committed tables, subscriptions, publish log, and committed batch ids.
  Node state is rebuilt deterministically from committed tables.
  Re-applying an already committed `batch_id` is a no-op, so replaying a
  persisted prefix never republishes.

## JSON CLI

```
python3.11 -m bagra [--state STATE.json] SCRIPT.json
```

`SCRIPT.json` is `{"commands": [...]}` with commands `subscribe`,
`unsubscribe`, and `batch` (see `bagra/__main__.py` docstring and
`tests/test_cli.py` for the exact shape).  The CLI prints the records
published by each command as JSON and exits non-zero if any command
failed (failed batches roll back; later commands still run).

## Library example

```python
from bagra import Engine, scan, join, distinct, project

eng = Engine()
eng.add_subscription("report", distinct(project(
    join(scan("R"), scan("S"), [0], [0]), [1, 3])))
eng.apply_batch([("R", (1, "a"), 1), ("S", (1, "b"), 1)], batch_id=1)
# -> publishes {"version": 1, "subscription": "report", "seq": 0,
#               "row": ["a", "b"], "delta": 1}
```

## Tests

```
python3.11 -m unittest discover -s tests -v
```

* `tests/test_engine.py` — targeted scenarios: self join, same-batch
  deletes on both join sides, projection merging duplicates, distinct
  vanishing and reappearing, NULL join vs. set identity, a shared node
  feeding two outputs (computed once per batch), error-batch rollback,
  mid-stream recovery and replay dedup.
* `tests/test_property.py` — differential testing: 100 random trials
  enumerate small bag databases (domain `{NULL, 0, 1}`) and short
  transaction sequences over random plans using all eight operators
  with shared subexpressions; after every batch each output's
  accumulated publishes are checked against the independent
  full-relation interpreter (`bagra/interpreter.py`), including a
  save/recover/replay in the middle of each sequence.
* `tests/test_cli.py` — end-to-end CLI runs, including an error batch
  and recovery from a persisted state file.

Latest run (Python 3.11.16): **15 tests, OK** (`Ran 15 tests in ~2.8s`).
