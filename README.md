# aggql

A tiny JSON aggregation query engine. Python 3.11+ standard library only.

## Usage

```
python -m aggql query.json rows.json
```

- `rows.json`: a JSON array of objects (input rows). Missing keys and explicit
  `null` are both treated as SQL NULL.
- `query.json`: a JSON object describing the query (see below).
- Result rows are printed to stdout as a JSON array, deterministically sorted.

Exit codes: `0` success, `1` I/O or JSON parse errors, `2` invalid query
(including unknown aggregate columns).

## Query format

```json
{
  "group_by": ["dept"],
  "aggregates": [
    {"func": "COUNT", "arg": "*", "as": "n"},
    {"func": "SUM", "arg": "amount", "distinct": true, "as": "total"},
    {"func": "AVG", "arg": "amount", "as": "avg"}
  ],
  "having": {"cmp": ">", "left": {"agg": "n"}, "right": {"lit": 1}}
}
```

- `group_by` (optional, default `[]`): column names. NULL keys form their own
  group. With no `group_by`, the whole input is one group (even when empty).
- `aggregates`: list of `{func, arg, distinct?, as?}`.
  - `func`: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`.
  - `arg`: column name, or `"*"` (only for `COUNT`, without `distinct`).
  - `distinct`: deduplicate values before aggregating; all NULLs count as the
    same value.
  - `as`: output alias (a default is derived when omitted).
- `having` (optional): expression evaluated per group under SQL three-valued
  logic; only groups where it is TRUE are kept.

## Semantics

- `COUNT(*)` counts input rows; `COUNT(col)` ignores NULLs.
- `SUM`/`AVG`/`MIN`/`MAX` ignore NULLs; over an empty set they yield NULL
  (`COUNT` yields 0).
- `AVG` is emitted as a reduced fraction string, e.g. `"3/2"`; integers are
  `"n/1"`.
- HAVING three-valued logic: any comparison involving NULL is UNKNOWN;
  `NOT UNKNOWN` is UNKNOWN; `AND`/`OR` follow the SQL truth tables; only TRUE
  keeps the group.
- Referencing an unknown aggregate column (in `aggregates` or `having`)
  exits with code 2.

## HAVING expressions

- `{"agg": "alias"}` — value of an aggregate output
- `{"col": "name"}` — value of a GROUP BY column
- `{"lit": value}` — literal (raw JSON scalars also work)
- `{"cmp": op, "left": e, "right": e}` with `op` one of
  `=`, `!=`, `<`, `<=`, `>`, `>=`
- `{"and": [e, ...]}`, `{"or": [e, ...]}`, `{"not": e}`

## Tests

```
python -m unittest discover -s tests -v
```

Tests cross-check the engine against an independent reference implementation
(dict-based regrouping/recomputation with its own sorting) in
`tests/test_aggql.py`.
