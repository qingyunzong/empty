# cert-check

Certificate checkers for directed graphs, in TypeScript.

## What is verified

- **Path certificates** (`verifyPath`): each step references an edge by id and
  version; the checker confirms the edge exists, the version matches the
  current graph, edges form a directed walk from `start`, and the declared
  `totalCost` equals the sum of edge costs. Repeated nodes are rejected unless
  `allowRepeatedNodes: true`. Errors report the first failing step index in
  `position`.
- **Optimality certificates** (`verifyOptimality`): a path certificate plus a
  potential per node. Every edge must satisfy the triangle inequality
  `potential[to] <= potential[from] + cost`, and the path cost must reach the
  lower bound `potential[target] - potential[source]`. Negative edges are
  allowed.
- **Negative-cycle certificates** (`verifyNegativeCycle`): a separate
  certificate type; the walk must be a closed directed cycle with total
  cost < 0.

## Generating certificates

`generateOptimalityCertificate(graph, source, target)` runs Bellman-Ford and
returns a certificate (null on reachable negative cycle / unreachable nodes).
`generateNegativeCycleCertificate(graph, source)` extracts a reachable
negative cycle. `pathCertificateFromEdges` builds a path certificate from
explicit edge ids.

## Tests

```
npm test        # tsc + node --test dist/tests/*.test.js
npm run typecheck
```

Tests include handcrafted certificates (not just generator output),
field-by-field corruption of valid certificates (all corruptions must be
rejected), and a reference check on random small graphs that enumerates all
simple paths to confirm the verifier never accepts suboptimal claims.
