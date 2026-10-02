# equip-award

Offline, single-machine CLI + library for selecting equipment combinations that
satisfy an order's process requirements under certificate and budget constraints.
Node.js 22 standard library only; tests use `node:test`.

## Data model

```json
{
  "order":    [{ "order": "O1", "process": "P1" }],
  "machines": [{ "machine": "M1", "process": "P1", "cert_expiry": "2027-01-01" }],
  "costs":    [{ "machine": "M1", "shift_cost": 10 }],
  "budget":   20
}
```

`cert_expiry: null` means the machine holds no valid certificate and can never
qualify for that process (relational division ignores it).

## Selection rule

A combination is feasible when its members' valid certificates cover every
required process and its total `shift_cost` is within `budget`. Among feasible
combinations the award is deterministic: fewest machines, then lowest total
cost, then lexicographic by sorted machine ids.

When nothing fits, the result is `infeasible` with a minimal certificate:
`missing_capability` (a required process no machine is certified for) or
`budget` (the cheapest covering combination's cost exceeds the budget).

## CLI

```sh
node cli.js candidates   --input examples/data.json
node cli.js award        --input examples/data.json --state state.json
node cli.js apply-change --state state.json --change examples/budget-cut.json
```

- `candidates` — relational division per process plus all feasible combinations.
- `award` — the winning combination (or infeasible certificate); persists
  `{ data, award }` to `--state` for incremental updates.
- `apply-change` — applies an incremental event (`revoke_cert` or
  `set_budget`), retracts the old award, and reports the old→new diff plus the
  re-allocation certificate. Exit code is 1 when the result is infeasible.

## Tests

```sh
node --test
```

Covers the three acceptance scenarios (lexicographic tie-break, null-cert
exclusion, budget-cut re-allocation) and cross-checks `award` against an
independent full-subset enumeration for ≤12 machines.
