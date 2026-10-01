# radb — mini relational database

A small relational query engine with cost-based left-deep join ordering,
implemented with the Python 3.11 standard library only.

## Usage

```
python -m radb query.json catalog.json tables_dir
```

* On success: writes `result.json` (a JSON array of row objects) to the
  current directory, prints a JSON summary to stdout, exits with code 0.
* On any user-facing error (unknown/ambiguous column, missing file, invalid
  query or catalog, unsupported operator): prints **only** a JSON error
  object `{"error": "..."}` to stdout, produces **no** result file, exits
  with code **2**.

## Input formats

### query.json

```json
{
  "select": ["R.a", "S.b"],
  "from": ["R", "S"],
  "where": [
    {"left": "R.a", "op": "=", "right": "S.a"},
    {"left": "R.b", "op": "=", "right": 5},
    {"left": "S.c", "op": "<", "right": 10}
  ]
}
```

* `select`: non-empty list of column references. A reference is either
  qualified (`R.a`) or bare (`a`); bare names must resolve to exactly one
  table in `from`, otherwise the query is rejected as ambiguous/unknown.
* `from`: non-empty list of table names (no self-joins).
* `where` (optional): list of conditions. Supported operators: `=`, `<`, `>`.
  * column `=` column  → join predicate (or an intra-table filter when both
    columns belong to the same table);
  * column op constant → filter pushed down to the base table;
  * a JSON number/boolean is a constant, a JSON string is a column
    reference; use `{"const": "x"}` for string constants and
    `{"column": "R.a"}` for explicit references.

### catalog.json

Statistics used by the cost model:

```json
{
  "R": {"cardinality": 1000, "columns": {"a": {"ndv": 100}, "b": {"ndv": 10}}}
}
```

`cardinality` and every `ndv` must be positive integers.

### tables_dir

One CSV file per table (`tables_dir/R.csv`) with a header row covering all
catalog columns of the table. Fields are parsed as `int`, then `float`,
else kept as strings.

## Semantics

1. **Selectivity**: equality filter on a column = `1/NDV(column)`;
   `<` / `>` filters = `1/3`. Join cardinality =
   `card(L) * card(R) / max(NDV(left key), NDV(right key))` for each
   equality predicate connecting the two sides. All estimation uses exact
   rational arithmetic (`fractions.Fraction`).
2. **Optimization**: every left-deep join order (all permutations of the
   `from` tables) is enumerated. The cost of an order is the sum of the
   filtered base-table scan cardinalities plus the cardinality of every
   intermediate join result. The cheapest order wins; ties are broken by
   the lexicographically smallest sequence of joined table names.
3. **Execution**: filters are pushed down to the base tables; joins run in
   the chosen order. The final result uses set semantics (duplicates
   removed) and rows are sorted by their JSON representation
   (`json.dumps(row, sort_keys=True)`). Output row keys are the qualified
   column names (`R.a`).

## Tests

```
python -m unittest discover -s tests -v
```

The join-order tests validate the engine against an independent reference
algorithm in `tests/test_radb.py` (`reference_orders`) that enumerates all
permutations with `itertools.permutations` and applies the cost formulas
directly. Covered scenarios:

* a three-table query whose optimal order differs from the written order;
* a four-way cost tie resolved by lexicographic table order;
* seeded randomized 4-table scenarios checked against the reference;
* error cases (unknown column, ambiguous column, missing query/catalog/CSV
  files, unsupported operator) verifying exit code 2, a JSON error object
  on stdout, and the absence of any result file.
