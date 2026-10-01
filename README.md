# optrewrite

Logical plan optimizer for trees built from selections (conjunctive),
projections and binary inner joins. Pure Python 3.11 standard library.

## Usage

```
python -m optrewrite query.json stats.json budget.json
```

- Exit `0`: prints `{"cost": C, "plan": ...}` — the optimal canonical plan,
  emitted only when its cost is less than or equal to the budget.
- Exit `2`: unknown column — prints `{"error": "unknown_column", "column": ...}`.
- Exit `3`: cost exceeds budget — prints
  `{"error": "budget_exceeded", "cost": C, "budget": B}`.
- Exit `1`: malformed input (bad JSON, unknown relation, invalid node, ...).

All machine-readable results and error objects are printed to stdout.

## Input formats

### query.json

A plan tree of nodes:

```json
{"type": "relation", "name": "R"}
{"type": "select", "conditions": [COND, ...], "input": NODE}
{"type": "project", "columns": ["R.a", ...], "input": NODE}
{"type": "join", "left": NODE, "right": NODE}
```

`COND` is `{"left": "R.a", "op": "=", "right": {"const": 5}}` or
`{"left": "R.a", "op": "=", "right": {"col": "S.b"}}`. All column references
must be qualified (`Relation.column`). Each relation name may appear once.

### stats.json

```json
{
  "relations": {
    "R": {"cardinality": 1000, "columns": {"a": 100, "b": 10}}
  },
  "selectivities": {"R.b": 0.1}
}
```

`columns` maps each column to its NDV. `selectivities` maps a qualified
column to the selectivity of an equality predicate on a constant
(missing entries default to 1.0).

### budget.json

A JSON number (or `{"budget": N}`).

## Optimization semantics

1. **Selection pushdown.** Conjunctive conditions are pushed through
   projections and joins as far as possible. A condition is never pushed
   through a projection that drops a column it references; such conditions
   stay above the projection. Conditions referencing both sides of a join
   become equi-join predicates of that join.
2. **Join enumeration.** For every maximal group of joins, all binary join
   trees (all leaf orderings x all shapes) are enumerated. Equi-join
   cardinality on `R.a = S.b` is `|R| * |S| / max(NDV(R.a), NDV(S.b))`;
   multiple predicates on one join apply multiplicatively. The cost of a
   plan is the sum of the cardinalities of all intermediate (non-relation)
   nodes, including the root.
3. **Canonical plan.** Among minimum-cost plans, the one whose canonical
   JSON serialization (`json.dumps(plan, sort_keys=True,
   separators=(",", ":"))`) is lexicographically smallest is emitted.

## Examples

```
python -m optrewrite examples/query.json examples/stats.json examples/budget.json
```

## Tests

```
python -m unittest discover -s tests -t . -v
```

The join-order tests enumerate all binary trees independently of the
optimizer and cross-check the optimal cost.
