# assertplanner

CLI that plans a minimum-cost set of assertions (up to 18 candidates)
distinguishing every fault model (up to 12) from the normal model, subject
to side-effect mutex and public prerequisite constraints. Pure Go standard
library.

## Usage

```
go run ./cmd/planner              # built-in 18-assertion / 12-fault-model demo
go run ./cmd/planner -input spec.json
cat spec.json | go run ./cmd/planner -input -
go run ./cmd/planner -json        # certificate as JSON
```

Spec format: `normal` names the normal model; each assertion has `id`,
`cost`, optional `mutex` (side-effect conflicts, symmetric) and `requires`
(prerequisites, transitively closed); every model lists a boolean `outcomes`
map keyed by assertion id. A fault model is distinguishable when some
assertion outcome differs from normal.

## Output

The coverage certificate lists the selected assertions, total cost, a
witness assertion per fault model, and indistinguishable models separately.
Optimality is verified by an independent enumeration of subsets in
increasing cardinality, checking that no cheaper feasible subset exists.

## Test results (actual)

`GOCACHE=/tmp/gocache go test ./...` on go1.27.1 linux/amd64:

```
?   	assertplanner/cmd/planner	[no test files]
ok  	assertplanner/internal/planner	0.100s
```

9/9 tests PASS, including mutex/prerequisite constraints, indistinguishable
models, infeasibility, spec validation, and the 18x12 demo with enumeration
verification (35,874 cheaper-candidate subsets checked, none feasible).
