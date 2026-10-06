# depgraph

Directed dependency graph library (TypeScript, zero runtime dependencies).

## Features

- **Add/remove directed edges** — `addEdge`, `removeEdge`, or batched via `applyBatch`.
- **Atomic batches** — every op is validated before any mutation; one invalid op
  rejects the whole batch and leaves the graph untouched. Edges flipped back and
  forth within one batch cancel out (net effect only).
- **Self-loops allowed** — `addEdge('a', 'a')` works; every node also reaches
  itself via the empty path.
- **Reachability & shortest path** — `reachable(from, to)` and
  `shortestPath(from, to)`; among equally short paths the lexicographically
  smallest node sequence wins.
- **Affected source set** — `applyBatch` returns `affectedSources`: the sorted
  set of sources whose reachability may have changed (all sources that can reach
  the tail of a flipped edge, before or after the batch). Their per-source BFS
  caches are invalidated; untouched sources stay cached.

## Usage

```ts
import { DirectedGraph } from './src/graph';

const g = new DirectedGraph();
const { affectedSources } = g.applyBatch([
  { type: 'add', from: 'app', to: 'libA' },
  { type: 'add', from: 'libA', to: 'libB' },
]);

g.reachable('app', 'libB');        // true
g.shortestPath('app', 'libB');     // ['app', 'libA', 'libB']

g.removeEdge('libA', 'libB');      // affectedSources: ['app', 'libA']
g.reachable('app', 'libB');        // false (cache invalidated)
```

## Test

```sh
npm test   # tsc build + node:test, incl. randomized differential
           # testing against a cache-free per-source BFS reference
```
