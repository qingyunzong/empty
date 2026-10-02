# dq-rules

Rule-based data-quality checking, repair, planning, versioned merge and
history replay for scientific datasets. Node.js 22, standard library only,
tests with `node:test`.

## Model

- **Dataset**: `{ data: {var: int}, domains: {var: [lo, hi]}, costs: {var: unitCost} }`.
  Domains are inclusive integer ranges; repair cost is `sum(|new-old| * unitCost)`.
- **Rules**: `range` / `leq` / `eq` / `sumLeq` / `sumEq`, each with an `id` and
  optional `dependsOn: [id]`. Dependencies form a DAG; any cycle fails with
  `RULE_CYCLE`.
- **Version**: content-addressed snapshot `{ id, vector, data, domains, history }`.
  `vector` is a vector clock; `history` is the causal event log
  (genesis / repair / merge). `repair` produces a new causal successor.
- **Merge**: concurrent versions merge commutatively via three-way resolution
  against the latest common ancestor (ties: larger version id wins).
  Identical vector clocks with divergent data fail with `HISTORY_CONFLICT`.
- **Feasibility**: `NO_FEASIBLE` is returned only after exhaustive enumeration
  proves no assignment with cost `<= budget` exists. A node-limit abort raises
  `SEARCH_LIMIT` instead — a timeout is never reported as infeasible.
- **Plans**: candidate repairs ranked by (fixed violations desc, cost asc,
  plan hash asc).

## CLI

```
node src/cli.js check   --data dataset.json --rules rules.json
node src/cli.js repair  --data datasetOrVersion.json --rules rules.json --budget N --node NAME [--max-nodes K]
node src/cli.js plan    --data datasetOrVersion.json --rules rules.json --budget N [--limit N] [--max-nodes K]
node src/cli.js merge   --left versionA.json --right versionB.json
node src/cli.js explain --version version.json
```

JSON on stdout; errors are JSON on stderr with exit code 1
(`RULE_CYCLE`, `NO_FEASIBLE`, `HISTORY_CONFLICT`, `SEARCH_LIMIT`, `BAD_INPUT`).

## Library

```js
import { checkData, optimalRepair, enumeratePlans,
         genesis, applyRepair, mergeVersions, explain } from './src/index.js';
```

## Tests

```
node --test
```
