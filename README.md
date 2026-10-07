# cert-check

Verifiable certificates for directed graphs (TypeScript, zero dependencies).

## Certificates

- **Path certificate** (`src/pathCertificate.ts`): proves a directed s-t path
  exists with a given total cost. Each step pins an edge id plus the edge
  version seen at proving time; the verifier re-checks contiguity, versions,
  and the cost sum. Repeated nodes are rejected by default and allowed via
  `{ allowRepeatedNodes: true }`. Failures report the first failing step
  index (`position`); terminal mismatches (wrong target/cost) report
  `steps.length`.
- **Optimality certificate** (`src/optimalityCertificate.ts`): proves a path
  is a shortest s-t path. Per-node potentials must satisfy the triangle
  inequality `h[v] <= h[u] + w(u,v)` on every edge (so `h[t] - h[s]` is a
  lower bound on every s-t path), and the certified path cost must equal
  that bound. Negative edges are fine; generation throws when a negative
  cycle exists.
- **Negative-cycle certificate** (`src/negativeCycleCertificate.ts`): proves
  infeasibility of potentials — a closed directed walk with negative total
  weight, verified independently.

## Tests

```sh
npm test
```

Compiles with `tsc` and runs `node --test`. Tests corrupt every certificate
field (sources, targets, costs, edge ids, edge versions, potentials) on
fresh clones of genuinely valid certificates and assert rejection at the
expected first position; optimality is additionally cross-checked against
an exhaustive all-simple-paths reference on a small graph to catch false
acceptance.
