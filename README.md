# transfer-cli

Min-cost transfer CLI on a directed account graph. Sends up to **20 integer
units** from a source account to a sink account across edges with capacities
and **piecewise (segmented) per-unit fees**, requiring the source's net
outflow to equal the sink's net inflow exactly. Fees may be negative, but
inputs containing a negative-cost cycle are rejected. The solver prints the
minimum-cost flow together with a **residual-potential optimality
certificate**, and a brute-force enumerator cross-checks small networks.

Pure TypeScript + Node.js built-ins. No runtime dependencies.

## Requirements

- Node.js (developed on v22)
- A TypeScript compiler on PATH (`tsc`; used only to build, no `npm install`
  is needed — there are no dependencies)

## Build, test, run

```sh
npm test          # tsc build + node --test (17 tests)
npm run build     # compile src/ and test/ to dist/
node dist/src/cli.js --input examples/sample.json
node dist/src/cli.js --enumerate < examples/sample.json
```

## Input format (JSON, file or stdin)

```json
{
  "nodes":  ["alice", "bob", "dave"],
  "source": "alice",
  "sink":   "dave",
  "amount": 5,
  "atMost": false,
  "edges": [
    { "from": "alice", "to": "bob", "capacity": 4,
      "segments": [ { "upTo": 2, "unitCost": 1 },
                    { "upTo": 4, "unitCost": 3 } ] }
  ]
}
```

- `segments` are per-unit fee brackets: the first `upTo` units of the first
  segment cost `unitCost` each, and so on. The last `upTo` must equal
  `capacity`.
- Marginal fees must be **non-decreasing** within an edge (convex piecewise
  costs); otherwise the unit-expansion model is invalid and the input is
  rejected.
- `amount` is an integer in `[0, 20]`. With `atMost` (or `--at-most`), the
  solver minimizes cost over every flow value in `[0, amount]` — useful when
  negative fees make smaller/larger transfers cheaper.
- Negative `unitCost` is allowed. Any negative-cost cycle in the input graph
  is detected (Bellman-Ford) and rejected.

CLI flags: `-i/--input FILE`, `-a/--amount N`, `--at-most`, `--enumerate`,
`-h/--help`. Exit codes: `0` optimal, `2` infeasible (max flow < amount),
`1` invalid input.

## Output

JSON with the flow per edge, total cost, per-node **potentials**, and a
certificate object. The certificate verifies:

1. **capacity** — `0 <= flow <= capacity` on every edge;
2. **conservation** — net outflow is `sent` at the source, `-sent` at the
   sink, `0` elsewhere (source net outflow == sink net inflow);
3. **cost** — reported cost equals the piecewise fee sum;
4. **reduced costs** — every residual arc has non-negative reduced cost
   `c(u,v) + π(u) - π(v) >= 0` (forward residual units) and
   `-c(u,v) + π(v) - π(u) >= 0` (backward residual units). By convexity it
   suffices to check the cheapest residual unit per direction per edge.

Condition 4 is the classic primal-dual optimality certificate: no improving
cycle or path exists in the residual graph, so the integral flow is
min-cost.

## Algorithm

1. **Unit expansion** — each edge's fee segments become unit-capacity arcs
   priced at the segment's marginal fee (capped at 20 units per edge, since
   the source never emits more).
2. **Successive shortest paths** — potentials are initialized with
   Bellman-Ford from a super-source (handles negative fees, detects negative
   cycles), then Dijkstra with reduced costs augments one shortest path at a
   time, at most 20 times. This yields the min cost for *every* flow value
   `0..amount`, which also answers the `--at-most` variant.
3. **Certification** — final potentials are recomputed on the residual
   graph and all four certificate checks are evaluated.
4. **Enumeration** (`src/enumerate.ts`) — independently enumerates every
   integral edge-flow assignment (guarded to <= 5M combinations) and reports
   the min cost per flow value; used by `--enumerate` and by the randomized
   cross-check tests.

## Layout

- `src/graph.ts` — input validation, piecewise cost helpers
- `src/mincostflow.ts` — unit expansion + SSP solver
- `src/certificate.ts` — residual-potential certificate verification
- `src/enumerate.ts` — brute-force enumerator for small networks
- `src/cli.ts` — command-line interface
- `test/` — unit tests, randomized enumeration cross-checks (600 seeded
  random networks), CLI end-to-end tests
- `types/` — minimal ambient declarations for the Node built-ins used
  (the offline environment cannot install `@types/node`)

See `RESULTS.md` for the recorded `npm test` output.
