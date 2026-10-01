# csp_budget

Budget-limited AC-3 constraint propagation library + CLI. Pure Python 3.11
standard library, fully offline.

## Input format (JSON)

```json
{
  "variables": {"X": [1, 2, 3], "Y": [1, 2, 3]},
  "constraints": [
    {"scope": ["X", "Y"], "allowed": [[1, 2], [2, 3]]}
  ]
}
```

- `variables`: object mapping variable name to its enumerated integer domain.
- `constraints`: list of binary allowed-pair constraints; `scope` holds the two
  variable names, `allowed` lists the permitted `[value1, value2]` pairs.

## CLI

```
python -m csp_budget propagate --input <problem.json> --budget <non-negative int>
```

Output JSON: `status` (`complete` / `unsat` / `timeout`), `domains`,
`used_budget`.

## Budget semantics

- Each single value-pair match check costs 1 budget unit, deducted *before*
  the check runs. Budget 0 at the next check stops propagation immediately,
  keeping all modifications, with status `timeout`.
- Any domain becoming empty stops propagation immediately: status `unsat`,
  remaining budget discarded.
- Reaching a fixpoint with all domains non-empty: status `complete`.
- Budget 0 with no empty initial domain returns the initial domains as
  `timeout`; an empty initial domain is always `unsat`.

## Errors (non-zero exit)

Negative budget, malformed JSON/problem shape, or a constraint referencing an
unknown variable.

## Tests

```
python -m unittest discover -v
```

Includes a naive AC-3 reference implementation with a full execution log
(`csp_budget.solver.reference_ac3`) used for differential testing. Real test
results are recorded in `result.txt`.
