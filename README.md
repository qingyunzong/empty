# Budget-Aware Rollback

Rollback planner + CLI for hierarchical experiment activities in a single-node,
offline Node.js 22 environment. Standard library only; tests use `node:test`.

## Model

An activity is a tree: a root project, child experiments, and step nodes.
Each node has a `cost`, a `status` (`active` | `rolled-back`) and a version
`hash`. State lives in a JSON file:

```json
{
  "nodes": [
    { "id": "proj",  "parent": null,   "cost": 4, "status": "active",      "hash": "h-proj" },
    { "id": "exp1",  "parent": "proj", "cost": 3, "status": "active",      "hash": "h-exp1" },
    { "id": "step1", "parent": "exp1", "cost": 2, "status": "active",      "hash": "h-step1" },
    { "id": "step2", "parent": "exp1", "cost": 5, "status": "rolled-back", "hash": "h-step2" }
  ]
}
```

Exactly one root (`parent: null`) is required; every node must descend from it.
Missing hashes default to a deterministic digest of the node id.

## Rollback semantics

- Rolling back a node first rolls back all of its **active descendants**
  (execution order: deepest first, path order among siblings).
- **Ancestor/descendant constraint:** a rollback set covers the target iff some
  selected node is the target or one of its ancestors — the cascade then
  reaches the target. Feasible sets are the inclusion-minimal covering sets,
  i.e. the singletons `{a}` for `a` in `{target} ∪ ancestors(target)`.
- **Cost** of a set is the sum of costs over the *active* nodes in the union of
  its closures: shared nodes are charged once, already rolled-back nodes are
  never charged again.
- **Selection:** among feasible sets with `cost <= budget` pick the minimum
  cost. Ties are broken by the lexicographically smallest concatenation of the
  set's node paths (paths sorted, then concatenated).
- **Infeasible:** if the minimum feasible cost exceeds the budget, the CLI
  writes `infeasible.json`, exits with code `2`, and no node is changed.
- **Certificate:** a successful `commit` writes `certificate.json` recording
  the plan, the execution order, and the old/new version hash of every
  rolled-back node, plus digests of the pre- and post-commit state.
  `newHash = sha256("rollback\0" + id + "\0" + oldHash)`.

## CLI

```
node cli.js plan   <state> --node <id> --budget <n> [--out <file>]
node cli.js commit <state> --node <id> --budget <n> [--cert <file>] [--out <file>]
node cli.js verify <state> [--cert <file>]
```

- `plan` prints the selected plan (nodes, cost, affected execution order)
  without touching the state.
- `commit` executes the plan, atomically rewrites the state file, and writes
  the certificate (default `certificate.json`).
- `verify` checks the certificate against the current state: hash transitions,
  descendants-first order, closure membership, per-node hashes, and the
  whole-state digest.

Exit codes: `0` success, `1` error / verification failed, `2` infeasible.

## Layout

- `src/state.js` — state loading/validation, tree helpers, digests
- `src/planner.js` — cost accounting, constraints, min-cost selection, tie-break
- `src/certificate.js` — hash transitions, certificate build/apply/verify
- `src/commands.js` — CLI commands (in-process entry, returns exit codes)
- `cli.js` — thin executable wrapper
- `test/rollback.test.js` — `node:test` suite

## Tests

```
node --test
```

Covers: exact-budget success, budget-insufficient with zero side effects,
tie-breaking among equal-cost sets, shared-node / rolled-back cost accounting,
descendants-first execution order, certificate tampering, and a brute-force
cross-check that enumerates *all* node subsets satisfying the tree constraints
to confirm the library's minimum-cost selection on randomized trees.
Real output of the last run is saved in `test-results.txt`.
