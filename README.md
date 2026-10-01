# radb

A tiny relational query engine over CSV tables with a cost-based,
left-deep join-order optimizer. Python 3.11+ standard library only.

## Usage

```
python -m radb query.json catalog.json tables_dir [output.json]
```

The result JSON (selected columns, chosen join order, estimated cost,
result rows) is printed to stdout, or written to `output.json` when the
optional fourth argument is given. On any user-facing error (unknown or
ambiguous column, missing file, malformed input) the CLI prints a JSON
error object `{"error": ...}` to stdout, exits with code 2, and produces
no result file.

## Formats

`catalog.json` — table statistics (NDV = number of distinct values):

```json
{
  "A": {"file": "A.csv", "rows": 1000, "ndv": {"a": 100, "b": 5}}
}
```

`file` is optional and defaults to `<table>.csv` inside `tables_dir`.
Each CSV has a header row; values are parsed as int, then float, else str.

`query.json`:

```json
{
  "select": ["A.a", "B.c"],
  "from": ["A", "B"],
  "where": [
    {"op": "=", "left": "A.a", "right": "B.a"},
    {"op": "<", "left": "A.b", "right": 10}
  ]
}
```

Operands that are strings are column references (qualified `T.c` or
unqualified, resolved against the FROM tables; unresolvable or ambiguous
references are errors). Numbers/booleans are literals; use
`{"literal": "x"}` for string literals. Column-to-column `=` conditions
are join conditions; column-to-literal conditions are filters pushed
down to the base table. Supported operators: `=`, `!=`, `<`, `>`, `<=`, `>=`.

## Semantics

- **Selectivity**: `=` filter → `1/NDV`; `<`/`>` (and `<=`/`>=`) → `1/3`.
- **Join cardinality**: `card(L) * card(R) / max(NDV left key, NDV right key)`;
  the join keys' NDV becomes the min of the two afterwards.
- **Optimization**: all left-deep join orders are enumerated; cost is the
  sum of the (filtered) base scans and every join-step result cardinality.
  The minimum-cost order wins; ties are broken by the lexicographically
  smallest sequence of table names.
- **Execution**: filters are pushed to base tables, joins follow the
  chosen order, and the projected result is deduplicated (set semantics)
  and sorted by the JSON representation of each row.

## Tests

```
python -m unittest discover -s tests -v
```

The optimizer is validated against an independent reference algorithm in
the test suite that brute-force enumerates all permutations.
