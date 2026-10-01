# csp_budget

Budget-limited AC-3 constraint propagation with a JSON CLI. Pure Python
standard library (3.11+), fully offline.

## Input format

```json
{
  "variables": {"x": [1, 2, 3], "y": [1, 2, 3]},
  "constraints": [
    {"var1": "x", "var2": "y", "allowed": [[1, 2], [2, 3]]}
  ]
}
```

`variables` maps names to enumerated integer domains; each constraint is a
binary allowed-pair constraint between two existing variables.

## CLI

```
python -m csp_budget propagate --input <problem.json> --budget <non-negative int>
```

Output is JSON with `status` (`complete` / `unsat` / `timeout`), `domains`
and `used_budget`. One budget unit is charged per single value-match check,
consulted before each check:

- `complete`: fixpoint reached, all domains non-empty; `used_budget` is the
  spent budget (the remainder is returned unused).
- `unsat`: a domain became empty; propagation stops immediately and the
  remaining budget is discarded.
- `timeout`: budget exhausted (undecided); all completed domain
  modifications are kept. Budget 0 with no empty initial domain returns the
  initial domains as `timeout`.

Errors (negative budget, malformed input, constraints referencing unknown
variables) exit with a non-zero code.

## Tests

```
python -m unittest discover -v
```

`tests/reference_ac3.py` contains an independent naive AC-3 implementation
with a full execution log used as the oracle for the comparison tests.
