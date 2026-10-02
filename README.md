# dq-rules

Rule-based data-quality engine for versioned scientific datasets, with repair
planning under a cost budget and mergeable concurrent edit histories.
Node.js 22, standard library only, tested with `node:test`.

## Concepts

- **Rules** (`range`, `eq`, `neq`, `sum_lte`, `sum_gte`) form a dependency
  graph via `dependsOn`. Evaluation happens in topological order; a cycle is
  rejected with `RULE_CYCLE` before any checking or searching.
- **Versions** carry a vector clock. `repair` never mutates: it emits a new
  causal successor whose clock strictly dominates its parent.
- **Plans** are assignments over variable domains. A plan is *feasible* when
  it resolves every rule and its cost is `<= budget`. `NO_FEASIBLE` is
  returned only after exhaustive enumeration proves no such plan exists;
  hitting the `maxStates` search cap raises `SEARCH_LIMIT` instead, which is
  never reported as infeasibility.
- **Plan ranking** is deterministic: resolved violations descending, cost
  ascending, content hash ascending.
- **Merge** of concurrent versions applies both deltas to the common
  ancestor. Disjoint changes commute (`merge(a,b) === merge(b,a)`); the same
  variable changed to two different values raises `HISTORY_CONFLICT`.
- **Explain** replays the causal history of a version deterministically
  (ordered by clock sum, then id) and verifies the replayed state matches.

## CLI

```
node bin/dq.js <command> [input.json]     # JSON from stdin when no file given
```

| Command  | Input                                             | Output                     |
|----------|---------------------------------------------------|----------------------------|
| `check`  | `{data\|version, rules}`                          | `{ok, order, violations}`  |
| `plan`   | `{data\|version, schema, rules, budget?, ...}`    | `{plans, best, states}`    |
| `repair` | `{version, schema, rules, budget?, node?}`        | `{version, plan}`          |
| `merge`  | `{base, a, b, node?}`                             | `{version, relation}`      |
| `explain`| `{versions, target}`                              | `{steps, final, matches}`  |
| `init`   | `{data, node?}`                                   | `{version}`                |

Errors are printed to stderr as `{"error": CODE, "message": ...}` with exit
code 1. Codes: `RULE_CYCLE`, `NO_FEASIBLE`, `HISTORY_CONFLICT`,
`SEARCH_LIMIT`, `BAD_INPUT`.

## Schema

```json
{
  "temp": { "domain": [0, 1, 2, 3], "costPerUnit": 1 },
  "mode": { "domain": ["a", "b"], "changeCost": 2 }
}
```

`changeCost` is a fixed cost per changed variable; `costPerUnit` scales with
the numeric distance (default: fixed cost 1).

## Tests

```
node --test
```

See `RESULTS.md` for the latest run summary.
