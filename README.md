# depcycle

Minimum-cost dependency cycle repair CLI for graphs with **at most 18 edges**.
Written in TypeScript, compiled with `tsc`, runtime uses Node.js built-in modules only.

## Features

- Deletes a minimum-total-cost set of edges to make the graph acyclic.
- Locked edges (`locked: true`) are never deleted; a cycle of locked edges is
  reported as the infeasibility witness.
- Entry→exit reachability relations (`reachability`) are preserved; the report
  carries one explicit path certificate per relation.
- Package-group prerequisites (`groups.<g>.requires`): deleting any edge of
  group `g` forces deletion of every edge of each required group (transitively).
- Total deletion cost must fit `budget`.
- Optimality is proven twice: exhaustive enumeration of all closed deletion
  subsets **and** an independent branch & bound; the report fails if they disagree.
- Each deleted edge carries a proof: either a witness cycle on which it is the
  unique deleted edge, or the group-prerequisite chain that forced it.
- `verify` subcommand independently re-checks a report (feasibility, topological
  order, path certificates, witness cycles, and optimality via re-enumeration).

## Usage

```sh
npm run build                       # tsc -p tsconfig.json
node dist/src/cli.js solve examples/full.json [--out report.json]
node dist/src/cli.js verify examples/full.json report.json
node dist/src/cli.js enumerate examples/full.json
```

Exit codes: `0` optimal/verified, `1` infeasible or verification failed, `2` usage error.

## Problem format

```json
{
  "edges": [{ "id": "e1", "from": "a", "to": "b", "cost": 3,
              "locked": false, "group": "g1" }],
  "budget": 15,
  "reachability": [{ "from": "app", "to": "net" }],
  "groups": { "g1": { "requires": ["g2"] } }
}
```

## Tests

```sh
npm test    # tsc build + node --test
```

Actual recorded result (2026-10-05, Node v22.22.1, tsc 7.0.2):

```
ok 1 - simple cycle: cheapest edge removed, topo order and certificates emitted
ok 2 - reachability constraint forbids the cheapest repair
ok 3 - locked cycle makes the problem infeasible and is reported
ok 4 - budget below minimum cost is diagnosed
ok 5 - group prerequisite closure forces extra deletions
ok 6 - group closure hitting a locked edge forbids that deletion
ok 7 - reachability impossible in the original graph is diagnosed
ok 8 - more than 18 edges is rejected
ok 9 - exactly 18 edges is accepted and solved
ok 10 - verifier accepts a genuine report and rejects tampering
ok 11 - verifier confirms infeasible reports
ok 12 - random graphs: branch&bound always agrees with exhaustive enumeration
ok 13 - topoOrder returns null exactly on cyclic graphs
ok 14 - enumeration evaluates each closed deletion set exactly once
# tests 14  # pass 14  # fail 0
```

CLI smoke results (actual):

- `solve examples/cycle.json` → optimal, cost 4, deletes `e3`
  (cheaper `e2` rejected because it breaks `a→d`), topo order `a b c d`.
- `solve examples/full.json` → optimal, cost 15 = budget, deletes
  `e3,e4,e8` (cycle breakers) plus `e9` forced by `legacy → docs`
  group prerequisite; both reachability certificates included;
  enumeration (96 closed subsets) and branch & bound agree at 15.
- `verify examples/full.json report.json` → all 12 checks PASS;
  a tampered report (`cost: 14`) fails `cost-matches`.
- `solve examples/locked-cycle.json` → infeasible, witness cycle
  `a → b → c → a` of locked edges.
