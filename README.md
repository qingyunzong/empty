# memjoin

Memory-constrained equi-join planner and executor.  Pure Python 3.11
standard library; tests use `unittest`.

## Usage

```
python -m memjoin query.json data.json --budget M
```

`M` is the maximum number of rows that may be resident at the same time.
It must be a positive integer; any other value (0, negative, non-integer)
exits with code 2.  The result is printed to stdout as JSON:
`{"rows": [...], "plan_trace": {...}}`.

## Input formats

`query.json`:

```json
{
  "tables": ["users", "orders"],
  "joins": [
    {"left": "users", "left_attr": "id", "right": "orders", "right_attr": "user_id"}
  ]
}
```

* 2 to 4 tables; each join is one equi-condition between two tables
  (several conditions between the same pair are allowed).  The dotted
  form `{"left": "users.id", "right": "orders.user_id"}` also works.

`data.json`: `{"users": [{"id": 1, ...}, ...], "orders": [...]}`.

Result rows use qualified attribute names (`users.id`, `orders.user_id`).
NULL (`null`) join keys never match, not even each other.  Results follow
set semantics (duplicates removed) and are sorted by their canonical JSON
encoding.

## Planning

All left-deep plans are enumerated: every table permutation times
`{nested_loop, block_nested_loop, grace_hash}` per join step.  The cost of
a plan is the number of rows its operators read, computed with exact
subset cardinalities (the data is at hand, so statistics are perfect;
a deterministic selectivity estimate is used only if an intermediate
would exceed 1,000,000 rows):

* `nested_loop`: `|L| + |L| * |R|`
* `block_nested_loop`: `|O| + ceil(|O| / B) * |I|` with block
  `B = min(M, |O|)`; the cheaper orientation is chosen.
* `grace_hash`: `|L| + |R|` if the build side (the smaller input) fits in
  `M`, otherwise `2 * (|L| + |R|)` for one partition pass plus the join
  pass.

The feasible plan with the fewest rows read wins; ties are broken by
algorithm names, then by table order, both lexicographically ascending.

## Execution and memory discipline

The chosen plan is actually executed.  Operator buffers (BNLJ blocks,
hash build tables, in-memory intermediates) never exceed `M` rows:

* BNLJ reads its outer input in blocks of at most `M` rows.
* Grace hash join builds in memory only when the build side fits;
  otherwise both inputs are hash-partitioned to temporary JSONL files
  (fan-out <= 256) and joined partition by partition, recursing while a
  build partition still exceeds `M`.  If skew makes partitioning useless
  (all keys equal), the partition pair falls back to BNLJ.
* Intermediate results larger than `M` are spilled to temporary files.

All temporary files live in one directory that is removed when the run
ends; `plan_trace.execution` reports created/cleaned file counts,
partition events, fallbacks and the actual rows read.

## Tests

```
python -m unittest discover -s tests -v
```

Correctness is checked against an independent brute-force reference
(cartesian product + filter + dedup + sort) for 2-, 3- and 4-table joins
across budgets from 1 to 1000, plus CLI exit-code tests (`M=0` -> 2),
partitioning under tiny budgets, better plans under large budgets, skew
fallback, NULL handling, dedup and output ordering.

Latest run (Python 3.11.16 and 3.14.4): **20 tests, all OK**.
