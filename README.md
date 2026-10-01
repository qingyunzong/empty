# optrewrite

Logical-plan optimizer for trees of scans, conjunctive selections,
projections and binary inner joins.  Python 3.11 standard library only.

## Usage

```
python -m optrewrite query.json stats.json budget.json
```

Exit codes:

| code | meaning |
|------|---------|
| 0 | success; the optimal canonical plan JSON is printed to stdout |
| 1 | invalid input (bad JSON, malformed query, self join, ...) |
| 2 | unknown column (or missing selectivity); error object on stderr |
| 3 | optimal cost exceeds the budget; error object with `optimal_cost` on stderr |

## Input formats

### query.json

```json
{"type": "select", "conditions": [{"column": "R.a", "op": "=", "value": 42}],
 "input": {"type": "join", "condition": {"left": "R.x", "right": "S.y"},
           "left":  {"type": "scan", "relation": "R"},
           "right": {"type": "scan", "relation": "S"}}}
```

- `scan`: `{"type": "scan", "relation": "R"}`
- `select`: `{"type": "select", "conditions": [...], "input": ...}` —
  conjunction of predicates.  A predicate is either
  `{"column": "R.a", "op": "=", "value": ...}` or an equi-predicate
  `{"left": "R.a", "right": "S.b"}`.
- `project`: `{"type": "project", "columns": ["R.a", ...], "input": ...}`
- `join`: `{"type": "join", "condition": {...}, "left": ..., "right": ...}`
  (`"condition"` single, `"conditions"` list, or omitted for a cross product)

Columns are always qualified (`R.a`) and relation names must be unique.

### stats.json

```json
{"relations": {"R": {"cardinality": 1000,
                     "columns": {"a": {"ndv": 100}, "x": {"ndv": 200}}}},
 "selectivities": {"R.a": 0.1}}
```

### budget.json

A bare number (`350`) or an object (`{"budget": 350}`).

## Semantics

1. **Selection pushdown.**  Conjunctive predicates are pushed through
   projections and joins as far as possible.  A predicate is never pushed
   through a projection that drops a column it uses.  An equi-predicate
   whose columns end up on different sides of a join becomes a join
   condition.
2. **Join enumeration.**  All binary join trees over the base inputs of
   each join skeleton are enumerated.  Cardinalities:
   - scan: `cardinality` from stats
   - select: input card × given selectivity per predicate
   - project: input card
   - join: `|R| * |S| / max(V(R,a), V(S,b))` per equi-key condition
   Cost = sum of the cardinalities of all intermediate (non-scan) nodes.
   Arithmetic is exact (`fractions.Fraction`).
3. **Budget.**  The optimal plan is printed only when
   `cost <= budget` (equality accepted).  Otherwise exit code 3 with
   `{"error": "budget_exceeded", "optimal_cost": ..., "budget": ...}`.
4. **Canonical form / ties.**  Join children are ordered by their canonical
   JSON, conditions are sorted, and among minimum-cost plans the one with
   the lexicographically smallest canonical plan JSON
   (`json.dumps(plan, sort_keys=True, separators=(",", ":"))`) wins.
5. **Unknown columns** (referenced but absent from the stats) exit with
   code 2 and `{"error": "unknown_column", "column": ...}`.

## Tests

```
python -m unittest discover -v
```

The suite covers: pushdown reducing cost, pushdown blocked by dropped
columns, the equi-key cardinality formula, budget boundary acceptance /
rejection, tie-breaking by canonical JSON order, unknown-column exit code
2, and an independent brute-force enumeration of all binary join trees
cross-checked against the optimizer.

Latest run (Python 3.14.4, 2026-10-01):

```
Ran 13 tests in 0.986s

OK
```
