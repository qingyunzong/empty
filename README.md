# memjoin

Memory-constrained equi-inner-join planner and executor for 2–4 tables.
Pure Python 3.11 standard library; tests use `unittest`.

## Usage

```sh
python -m memjoin query.json data.json --budget M
```

- `M` must be a positive integer (maximum number of rows resident at once).
  Any other value exits with code **2** (as do unreadable/invalid inputs).
- On success the CLI prints `{"rows": [...], "plan_trace": [...]}` to stdout
  and exits 0.

### query.json

```json
{
  "tables": ["A", "B"],
  "joins": [{"left": "A", "left_key": "k", "right": "B", "right_key": "k"}]
}
```

### data.json

```json
{"A": [{"k": 1, "x": "p"}], "B": [{"k": 1, "y": "q"}]}
```

Try it: `python -m memjoin examples/query.json examples/data.json --budget 2`

## Semantics

- Inner equi-joins; **NULL join keys never match** (null ≠ null).
- **Set semantics**: duplicate result rows are removed; output rows are sorted
  by their canonical JSON encoding.
- Rows are merged as flat dicts; if two tables share a non-key column name the
  later-joined table wins, so keep non-key column names unique across tables.
- `rows_read` counts rows scanned from base tables and from temporary
  partition files; scanning in-memory intermediates is free.

## Planning

- Enumerates left-deep join orders whose prefixes stay connected in the join
  graph (all permutations if the graph is disconnected).
- Candidate algorithms per join step:
  - `nested_loop` — one outer row at a time (1 row resident);
  - `block_nested_loop` — outer blocks of at most `M` rows;
  - `grace_hash` — hash join; if the build side exceeds `M`, both sides are
    recursively hash-partitioned to temporary files (removed afterwards).
    Extreme skew that hashing cannot shrink falls back to block nested loop,
    so the budget always holds.
- Cost = estimated rows read. The cheapest plan wins; ties break on algorithm
  name, then table order (both lexicographic).

## Tests

```sh
python -m unittest discover -s tests -v
```

Correctness is checked against an independent brute-force reference
(cartesian product + filter + dedupe + sort) for 2-, 3- and 4-table joins
under budgets from 1 upward, plus partitioning, plan-choice, skew-fallback,
temp-file cleanup and CLI exit-code tests.
