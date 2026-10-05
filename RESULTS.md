# Test Results (actual recorded run)

- Date: 2026-10-05
- Node.js: v22.22.1
- TypeScript: 7.0.2 (`tsc -p tsconfig.json`)
- Command: `npm test` (= `npm run build && node --test dist/test/*.test.js`)

## `npm test` summary

```
# tests 2
# pass 2
# fail 0
```

(2 test files; 16 individual tests, all passing.)

## `node dist/test/solver.test.js`

```
ok 1 - prefers smaller maximum edge cost over smaller total cost
ok 2 - breaks maximum-edge ties by total cost
ok 3 - breaks full cost ties by node-id sequence
ok 4 - compares node ids naturally (numeric-aware)
ok 5 - routes through every checkpoint even when costly
ok 6 - never repeats a node
ok 7 - respects the 12-node visit limit by default
ok 8 - reports no path when the graph is disconnected
ok 9 - handles start equal to end
ok 10 - honours the directed flag
ok 11 - accepts numeric node ids
ok 12 - validates malformed input
ok 13 - matches exhaustive enumeration on 600 random small graphs
# tests 13
# pass 13
# fail 0
```

## `node dist/test/cli.test.js`

```
ok 1 - cli prints the witness and exits 0
ok 2 - cli exits 1 when no feasible path exists
ok 3 - cli exits 2 on missing file, bad json, invalid input, and bad usage
# tests 3
# pass 3
# fail 0
```

## Example run: `node dist/src/cli.js examples/graph1.json`

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

Exit code 0. (The cheaper `s -> b -> c -> t` route is rejected because its
bottleneck edge `b -> c` costs 9 > 4; the checkpoint `c` is covered.)
