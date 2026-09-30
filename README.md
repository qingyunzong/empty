# maskview

Row filtering, column masking and projection for in-memory relational
tables, with consistent visibility when multiple policies stack.
Python 3.11+ standard library only.

## CLI

```
python -m maskview query data.json policy.json ROLE [--sort-by COL] [--desc]
python -m maskview count data.json policy.json ROLE
```

- `query` prints the visible, masked rows as a JSON array (schema column
  order) on stdout, exit code 0.
- `count` prints `{"count": N}` — the only interface that reveals how
  many rows are visible.
- Any `PolicyError` prints `{"error": {"code": ..., "message": ...}}` on
  stderr and exits with code 2.

## Formats

`data.json`:

```json
{"columns": ["id", "name", "dept", "salary"],
 "rows": [{"id": 1, "name": "ada", "dept": "eng", "salary": 100}]}
```

`policy.json`:

```json
{"sensitivity": {"salary": "high"},
 "roles": {
   "analyst": {
     "row_filters": [{"when": "dept == 'ops'", "effect": "deny"}],
     "column_rules": [
       {"sensitivity_at_least": "high", "action": "hash"},
       {"column": "name", "action": "redact", "when": "salary is null"}
     ]}}}
```

- `row_filters[].effect`: `deny` (default) hides rows where `when` is
  TRUE; `allow` requires `when` to be TRUE. Filters combine with AND.
- `column_rules[]` select a column by `column` or by
  `sensitivity_at_least` (`low`/`medium`/`high`), carry an `action`
  (`clear`/`hash`/`redact`/`drop`) and an optional per-row `when`.

## Semantics

1. **Row filtering** — a row is visible only when the combined filter
   predicate is TRUE. Invisible rows disappear entirely; no null
   placeholder rows leak their existence.
2. **Column masking** — `hash` (deterministic `sha256:` digest),
   `redact` (`***`) or `drop` (key removed from the output row). A
   dropped column cannot be used as a sort key (`E_SCHEMA`).
3. **Conflict resolution** — per cell, the strictest applicable rule
   wins: `drop > redact > hash > clear`.
4. **Expressions** — three-valued logic (Kleene): comparisons against
   NULL yield UNKNOWN, `NOT UNKNOWN` is UNKNOWN, UNKNOWN is never
   silently treated as false. Referencing an unknown column raises
   `E_SCHEMA`. Literals `null`/`true`/`false` are supported alongside
   Python-style `None`/`True`/`False`.
5. **Projection** — output column order is always the schema order,
   independent of the order rules appear in the policy.

## Error codes

`E_SCHEMA` (unknown column / sort by dropped column), `E_POLICY`
(malformed policy), `E_EXPR` (invalid expression), `E_ROLE` (unknown
role), `E_SORT` (non-orderable values), `E_INPUT` (bad input files).
All exit with code 2.

## Tests

```
python -m unittest discover -s tests -v
```

Includes a fuzz test (`tests/test_fuzz.py`) that compares the engine
against an independent per-cell reference evaluator
(`tests/reference.py`) on random tables (≤20 rows) and random policies
(≤50 rules), checking both equal outputs and equal error codes.
