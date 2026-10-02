# budget-aware-rollback

Budget-aware rollback library and CLI for hierarchical experiment activities.
Pure JavaScript, Node.js 22, standard library only (`node:test` for tests).

## Model

An activity is a tree (shared nodes allowed): a root project, sub-experiments,
and step nodes. Each node has a `cost`, a `status` (`active` / `rolled_back`),
a version `hash`, and a unique `path`.

State file (`state.json`):

```json
{
  "root": "proj",
  "nodes": {
    "proj":  { "path": "proj", "children": ["exp1"], "cost": 100, "status": "active", "hash": "..." },
    "exp1":  { "path": "proj/exp1", "children": ["step1"], "cost": 12, "status": "active", "hash": "..." },
    "step1": { "path": "proj/exp1/step1", "children": [], "cost": 4, "status": "active", "hash": "..." }
  }
}
```

## Rollback semantics

Rolling back a node first rolls back all of its active descendants
(execution order is descendants-before-ancestors). A node ends up rolled back
when:

- it is **selected** (billed) — paying its `cost` cascades the rollback over
  its whole active subtree; or
- every one of its **active children** is rolled back (derived rollback: a
  node's version is a function of its children).

Constraints:

- **Ancestor/descendant**: a rolled-back node may never have active
  descendants (validated on load); active descendants always roll back before
  their ancestors.
- **Shared nodes** (reachable via several parents) are billed at most once.
- **Already rolled-back nodes** are never billed again and are excluded from
  every plan.
- A plan never bills a node already covered by another selected node's
  cascade, and never touches nodes outside the target's subtree.

The planner selects the **minimum-total-cost** billed set that rolls the
target back. If several sets have the same minimal cost, the one whose node
paths, sorted lexicographically and concatenated, is smallest wins. If that
minimum cost exceeds the budget, the plan is **infeasible**: `infeasible.json`
is written, the exit code is `2`, and no node is changed.

## CLI

```
node cli.js plan   <state> --node <id> --budget <n> [--out plan.json] [--infeasible infeasible.json]
node cli.js commit <state> --node <id> --budget <n> [--cert certificate.json] [--infeasible infeasible.json]
node cli.js verify <state> --cert <certificate.json>
```

- `plan` — dry run; writes `plan.json` (selected set, affected nodes in
  execution order, total cost) or `infeasible.json`.
- `commit` — like `plan`, but on success rewrites `<state>` in place and
  writes `certificate.json` pairing every rolled-back node's old and new
  version hashes (`newHash = sha256("rollback:<id>:<oldHash>")`).
- `verify` — checks the certificate against the state: every certified node
  must be rolled back at exactly the certified new hash, and each hash chain
  must be valid.

Exit codes: `0` success, `1` error (bad input, unknown/rolled-back target,
failed verification), `2` infeasible (budget exceeded; state untouched).

## Library

`src/rollback.js` exports `validateState`, `loadState`, `saveState`,
`planRollback`, `applyRollback`, `verifyCertificate`, `computeNewHash`,
`solveCover`, `computeCoverage`, and the `StateError` type.

## Tests

```
node --test
```

Covers exact-budget success, insufficient budget with no side effects,
tied minimal-set selection, shared-node dedup, rolled-back-node exclusion,
certificate verification, and a brute-force cross-check that enumerates every
valid node subset of random trees and compares cost and tie-break against the
planner. Latest real run: `test-results.txt`.
