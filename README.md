# checkpoint-path-cli

Finds a **simple path** (no repeated nodes) from a start node to an end node
that:

- visits **at most 12 nodes** (configurable via `maxNodes`),
- passes through **every specified checkpoint**,
- and is optimal under the lexicographic objective:
  1. **minimize the maximum edge cost** on the path (bottleneck / minimax),
  2. then **minimize the total cost**,
  3. then the **smallest node-id sequence** (natural, numeric-aware order:
     `n2` sorts before `n10`).

The CLI prints the **witness** (the optimal path and its metrics) as JSON.

## Requirements

- Node.js (developed on v22) — runtime uses only built-in modules.
- A `tsc` on `PATH` for the build step (TypeScript 7 was used; no `npm
  install` is needed, the project has zero dependencies).

## Usage

```sh
npm run build
node dist/src/cli.js examples/graph1.json
# or: npm start -- examples/graph1.json
```

Exit codes: `0` path found, `1` no feasible path, `2` usage/input error.

## Input format

```json
{
  "nodes": ["s", "a", "t"],
  "edges": [{ "from": "s", "to": "a", "cost": 3 }],
  "start": "s",
  "end": "t",
  "checkpoints": ["a"],
  "maxNodes": 12,
  "directed": false
}
```

- `edges` (required): `from`/`to` node ids (strings or numbers) and a finite
  numeric `cost`. Edges are **undirected** unless `"directed": true`.
- `start`, `end` (required). `checkpoints` defaults to `[]`.
- `maxNodes` defaults to `12` and counts every visited node, including
  `start` and `end`.
- `nodes` is optional; when present, every referenced id must be listed.

## Output (witness)

```json
{
  "found": true,
  "path": ["s", "a", "c", "t"],
  "maxEdgeCost": 4,
  "totalCost": 11,
  "nodeCount": 4,
  "checkpoints": ["c"],
  "maxNodes": 12
}
```

`maxEdgeCost`/`totalCost` are `null` when no path exists; `maxEdgeCost` is
also `null` for the trivial zero-edge path (`start == end`).

## Method

`src/solver.ts` enumerates simple paths with depth-first search, pruning
paths that exceed the node limit or already have a worse bottleneck than the
incumbent. `test/solver.test.ts` verifies the solver against an independent
exhaustive enumerator (`test/brute.ts`) on 600 seeded random small graphs,
plus targeted unit tests for each tie-break rule, the 12-node limit,
checkpoint coverage, and input validation. `test/cli.test.ts` drives the CLI
entry point (`run`) and checks stdout plus exit codes.

## Test

```sh
npm test
```

See `RESULTS.md` for the recorded actual run.
