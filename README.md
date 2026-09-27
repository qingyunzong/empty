# budgetsync

Generate a budgeted sequence of `set` / `delete` operations that converges a
current JSON object **B** toward a target JSON object **A**, using only the
Python 3.11 standard library.

## CLI

```
python -m budgetsync plan A B --budget N --out PLAN
```

- `A`, `B`: paths to JSON files that must each contain a JSON object.
- `--budget N`: maximum number of operations (`set` and `delete` each cost 1).
- `--out PLAN`: output path for the plan in [JSON Lines](https://jsonlines.org/)
  form, e.g. `{"key": "name", "op": "set", "value": 42}` or
  `{"key": "name", "op": "delete"}`.
- stdout prints one JSON object: `{"budget": N, "remaining": R, "selected": S}`.

A helper subcommand applies a plan (useful for testing and idempotency):

```
python -m budgetsync apply PLAN STATE --out RESULT
```

## Semantics

- Operations are top-level `set` (whole field value) or `delete`; cost 1 each.
- Gain is the number of matching fields after repair. Every mismatched field
  has exactly one repairing op, so each selected op raises the gain by 1.
- If the budget cannot repair every mismatch, the maximum-gain set is chosen.
  Ties are broken by key lexicographic order, then by op with
  `delete < set`. This is the prefix of candidates sorted by
  `(key, op_rank)`.
- No partial sets: a field value is replaced wholesale with the value from A
  (normalized), or the key is deleted.
- Plans are idempotent: applying the same plan repeatedly leaves the state
  unchanged after the first application.
- Nested values are compared structurally after JSON normalization; numeric
  equality makes `-0.0` equal to `0.0` (booleans stay distinct from numbers).

## Exit codes

- `0` success
- `1` I/O or malformed JSON
- `2` negative budget
- `3` A or B is not a JSON object

## Tests

```
python -m unittest discover -s tests -v
```

If the environment exposes only `python3` (as this one does), a local shim
is provided at `.bin/python`; prefix commands with
`PATH="$PWD/.bin:$PATH"` so the documented `python ...` invocations work.

The suite brute-forces every feasible repair subset for randomly generated
states with up to 12 top-level keys (`tests/test_budgetsync.py`) and asserts the
produced plan is budget-feasible, maximum-gain, and consistent with the
tie-breaking rule, plus budget-zero, normalization, exit-code, and idempotency
checks. The latest real run is recorded in `TEST_LOG.txt`.
