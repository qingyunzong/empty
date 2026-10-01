# csp_explain

1-UIP conflict explanation for backtracking search with implication
records.  Pure Python 3.11 standard library, fully offline.

## CLI

```
python -m csp_explain generate --input <conflict-record.json>
```

Prints a JSON object to stdout:

- `clause`: the 1-UIP explanation clause.  Each literal is a
  variable-value removal assertion
  (`{"kind": "removal", "variable", "value", "level", "constraint"}`)
  or an assignment assertion for a decision
  (`{"kind": "assignment", "variable", "value", "level"}`).
- `backjump_level`: the highest level in the clause below the conflict
  level (`0` for a unit clause).  `-1` together with an empty clause
  means the conflict stems from level-0 propagation alone and the
  problem is unsatisfiable (`status: "unsat"`).

Exit code is non-zero when the implication record references unknown
variables/decisions/implications, is internally inconsistent, or the
conflict state does not exist.

## Input format

```json
{
  "variables": ["x", "y"],
  "decisions": [{"variable": "x", "value": 1, "level": 1}],
  "implications": [
    {"id": "p1", "variable": "y", "removed_value": 2, "level": 1,
     "constraint": "c1", "antecedents": ["decision:x"]}
  ],
  "conflict": {"constraint": "c2", "antecedents": ["p1"]}
}
```

- Every implication node is one value-removal operation; antecedent
  edges point from premises to the removal they triggered.  An
  antecedent is either another implication id or `decision:<var>`.
- Implications are listed in propagation order; an implication's level
  must equal the maximum level of its antecedents.
- `conflict.antecedents` are the removals/assignments that made the
  conflicting constraint inconsistent.

## Semantics

The conflict clause is resolved backwards through the implication
graph until exactly one literal of the current decision level remains
(the first unique implication point).  Redundant literals whose
antecedents are already covered by the clause are removed, so the
clause contains only necessary premises.  The result is cross-checked
in the test suite against a naive reference that enumerates all cut
sets of the implication graph and filters the 1-UIP cuts.

## Tests

```
python -m unittest discover -v
```
