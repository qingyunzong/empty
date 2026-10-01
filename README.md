# bagra — incremental bag relational algebra

A small Python 3.11 (stdlib-only) engine that compiles bag relational
algebra queries into incremental dataflows for report subscriptions:
when base tables change, subscribers receive only the delta of the
result, never a full rescan.

## Operators

`scan`, `filter`, `project`, `join`, `union_all`, `intersect_all`,
`except_all`, `distinct`.

- Input changes carry **signed multiplicities**; every committed base
  table and every node result must stay non-negative, otherwise the
  whole batch is rejected.
- `except_all` is `max(left - right, 0)` — it clamps, never errors.
- Joins keep key indexes on both inputs and compute the batch delta as
  `ΔL ⋈ R_before + L_after ⋈ ΔR`, which includes the cross term
  `ΔL ⋈ ΔR` for simultaneous changes on both sides (and for self-joins).
- `distinct`, `intersect_all` and `except_all` track input multiplicities
  and emit changes exactly at 0-threshold crossings.
- NULL semantics: joins never match NULL keys (SQL `=`), while
  `distinct` / `intersect_all` / `except_all` treat NULL as a value
  (set identity); filter comparisons with NULL are unknown → false.

## Engine guarantees

- Queries are DAGs: shared subexpressions are updated **once per batch**
  (topological propagation) and may feed any number of downstream nodes.
- A batch is atomic: any error (unknown table, negative multiplicity, …)
  rolls back all tables and all node state; nothing is published and the
  version does not move.
- Subscriptions can be added/removed at any time. Publish records carry
  `version` and a global `seq`, subscriptions are notified in id order
  and rows in canonical order, so output is deterministic.
- `Engine.save(path)` persists tables, graph, subscriptions, version and
  the publish log atomically (tmp file + rename). `Engine.load(path)`
  recovers and recomputes operator state from the committed tables;
  replay never re-publishes already-published versions.

## Library usage

```python
from bagra import Engine

eng = Engine()
eng.add_table("R")
eng.add_node({"id": "r", "type": "scan", "table": "R"})
eng.add_node({"id": "d", "type": "distinct", "inputs": ["r"]})
eng.subscribe("d")
records = eng.apply_batch({"R": [((1, "a"), 1), ((1, "a"), 1)]})
# records == [{"version": 1, "seq": 1, "subscription": 1, "node": "d",
#              "changes": [[[1, "a"], 1]]}]
eng.save("state.json")
eng2 = Engine.load("state.json")
```

## JSON CLI

```
python3.11 -m bagra.cli script.json      # or "-" to read the script from stdin
```

The script is `{"load": path?, "save": path?, "commands": [...]}` with
commands `add_table`, `add_node`, `subscribe`, `unsubscribe`, `batch`,
`result`, `table`, `save`, `load`, `publish_log`. Output is a JSON array
with one result per command; a failed batch is reported as
`{"ok": false, "error": ...}`, fully rolled back, and does not stop the
script. See `tests/test_cli.py` for a complete example.

## Verification

`bagra/interpreter.py` is an independent, non-incremental evaluator of
the same algebra. The test suite enumerates small bag databases and
short transaction sequences (exhaustively for a tiny domain, randomly
for larger ones) and checks after every batch that each node's state and
the replayed publish deltas match the interpreter exactly.

```
python3.11 -m unittest discover -s tests -v
```
