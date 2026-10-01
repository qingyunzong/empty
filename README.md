# maskview

Row filtering, column masking, and projection over in-memory relational
tables, with consistent visibility semantics when multiple policies stack.

## CLI

```
python -m maskview query data.json policy.json <role>
```

Prints the visible rows as a JSON array on stdout. Any `PolicyError`
is reported as `{"error": <code>, "message": ...}` on stderr with exit
code 2.

## Data format (`data.json`)

```json
{
  "schema": [{"name": "id", "sensitivity": 0}, ...],
  "rows": [{"id": 1, ...}, ...],
  "sort": "id"                      // optional, or {"column": "id", "desc": true}
}
```

Rows may also be arrays (positional, matching schema order).

## Policy format (`policy.json`)

```json
{"rules": [
  {"type": "row_filter", "roles": ["analyst"], "expr": "dept == 'eng'"},
  {"type": "mask", "role": "analyst", "column": "salary", "action": "hash"},
  {"type": "mask", "level": 3, "action": "drop"},
  {"type": "mask", "column": "email", "action": "redact", "when": "active == true"}
]}
```

* `role` / `roles` restrict a rule to specific roles (absent = all roles).
* Mask rules target either a `column` or all columns with
  `sensitivity >= level`.
* Actions: `clear` (visible), `hash` (deterministic SHA-256), `redact`
  (`"***"`), `drop` (column removed entirely).

## Semantics

1. A row failing any row filter disappears completely — no null
   placeholder rows, no count metadata beyond the emitted array.
2. Dropped columns never appear in output and never participate in
   sorting; sorting by a dropped (or unknown) column fails with
   `E_SCHEMA`.
3. When several rules hit one cell, the strictest action wins:
   `drop > redact > hash > clear`.
4. Expressions use SQL-style three-valued logic. Unknown columns raise
   `E_SCHEMA`; a filter/`when` evaluating to UNKNOWN raises `E_EVAL`
   rather than being treated as false.
5. Output columns always follow schema order, independent of the order
   rules are written in.

Expression grammar: `and` / `or` / `not`, parentheses, comparisons
(`== != < <= > >=`) over columns, numbers, `'strings'`, `true`,
`false`, `null`.

## Error codes

`E_SCHEMA` (unknown column / bad sort key), `E_EVAL` (UNKNOWN or
type error at evaluation), `E_PARSE`, `E_POLICY`, `E_DATA`, `E_IO`,
`E_USAGE`. All exit with status 2.

## Tests

```
python -m unittest discover -s tests -v
```

Includes a randomized differential test (400 seeded trials, tables of
<= 20 rows, policies of <= 50 rules) cross-checking `maskview.engine`
against the independent per-cell reference evaluator in
`maskview/reference.py`.
