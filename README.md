# evidence-claim-validator

Incremental validation library + CLI for scientific evidence claims, built on
Node.js 22 standard library only (no dependencies, offline).

## Model

- **Evidence**: `{ id, weight, active }` — a weighted, retractable fact.
- **Claim**: a node of type `all`, `any`, or `quorum` (threshold) referencing
  evidence ids and/or other claim ids. Claim nodes carry a `weight`
  (default 1) used when a parent `quorum` sums them.
- **History**: ops produced by two operators, each stamped with a Lamport
  `clock` and `agentId`. Ops from all branches are merged and replayed in the
  deterministic total order `(clock, agentId, seq)`; the result is independent
  of branch order in the input.

## Ops

| op | fields | semantics |
| --- | --- | --- |
| `addEvidence` | `id, weight?, active?` | upsert evidence (default weight 1, active) |
| `setWeight` | `id, weight` | last writer in total order wins |
| `retract` / `restore` | `id` | set `active` false / true (idempotent) |
| `addClaim` | `id, type, threshold?, weight?` | upsert claim node |
| `addEdge` | `claim, ref` | add reference (duplicate adds are no-ops) |
| `removeEdge` | `claim, ref` | remove reference |

After every op, only the claims transitively depending on the touched node are
marked dirty and recomputed (`Store#settle`), so retractions and edge changes
propagate invalidation incrementally along the reverse dependency graph.

## Errors and certificates

- Cycles in the claim graph yield `E_CYCLE`; unknown references yield `E_REF`.
  Errors propagate to dependents with a rejection reason chain.
- `certificate(store, claimId)` returns `{ claim, state, support, reasons,
  stateHash }` where `support` is the minimal set of currently-active evidence
  sufficient to satisfy the claim (minimum cardinality, lexicographic
  tie-break; `null` when unsatisfiable), and `stateHash` is the SHA-256 of the
  canonical state (evidence, claims, statuses).

## CLI

```sh
node cli.js replay <history.json...>      # merged final state as JSON
node cli.js cert <claimId> <history.json...>   # certificate as JSON
```

History files are JSON: a plain op array, `{ "ops": [...] }`, or
`{ "branches": { "alice": [...], "bob": [...] } }`. `-` reads stdin.

## Tests

```sh
node --test
```

Includes a brute-force cross-check: for random scenarios with at most 7
claims, the library's minimal support set is compared against enumerating all
subsets of the active evidence.
