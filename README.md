# exactcount

Exact solution counter for finite integer domains with allowed-tuple table
constraints, designed for scheduling-style analyses that need **trustworthy
bounds under a strict budget** and **pause/resume** across processes.

Pure Python 3.11 standard library; tests use `unittest`.

## What it computes

Given variables with finite integer domains and table constraints (allowed
tuples), the solver maintains:

- `confirmed_lower` — solutions already confirmed (sound lower bound),
- `certified_upper` — verified upper bound: confirmed solutions plus the
  product of the remaining domains over every unexplored frontier node
  (frontier nodes are pairwise disjoint assignment spaces, so nothing is
  counted twice),
- `complete` — whether the search finished,
- `exact` — reported **only** when lower == upper (complete search). A
  budget-exhausted run never claims "no solution" or an exact count,
- a resumable **checkpoint** (JSON) and a verifiable **certificate** (JSON).

## How it works

- **Propagation + deterministic branching.** GAC (generalized arc
  consistency) propagation, then branching on the smallest-domain variable
  (ties by name), values in sorted order. Fully deterministic.
- **Component factorization.** After propagation, the constraint graph's
  independent connected components are counted separately and multiplied.
- **Canonical subproblem cache.** Cache keys carry the variable domains and
  the involved constraints (id, version, scope, tuples). After constraints
  are added or revoked, only entries whose recorded domains/versions still
  match are reused — everything else is recomputed.
- **Budget = value-support checks.** One budget unit per support check
  (does value `v` of variable `x` still have a supporting tuple in
  constraint `c`). The search may pause after any check: propagation queue
  entries persist their per-entry progress (pending values + changed flag),
  so resuming in a new process never loses or repeats work, and the tree
  leaves always partition the remaining assignment space.
- **Independent certificate checker.** `exactcount/checker.py` does not
  import the solver. It re-verifies from the certificate alone: soundness of
  every domain reduction (each removed value is unsupported), branch
  coverage, component factorization, every confirmed solution, frontier
  coverage, pairwise frontier disjointness, and the claimed bounds.

## CLI

```sh
# solve with a budget, keep a checkpoint and a certificate
python3.11 -m exactcount solve problem.json --budget 100 \
    --checkpoint-out cp.json --certificate-out cert.json

# resume in a new process
python3.11 -m exactcount solve problem.json --checkpoint-in cp.json \
    --budget 100000 --checkpoint-out cp2.json --certificate-out cert.json

# exact count with unlimited budget
python3.11 -m exactcount count problem.json

# independently verify a certificate (exit code 0 = valid)
python3.11 -m exactcount verify cert.json
```

### Problem JSON

```json
{
  "variables": {"x": [0, 1, 2], "y": [0, 1, 2]},
  "constraints": [{"scope": ["x", "y"], "tuples": [[0, 0], [1, 1], [2, 2]]}]
}
```

### Result JSON

```json
{
  "confirmed_lower": 0, "certified_upper": 9, "complete": false,
  "exact": null, "checks_this_run": 100, "checks_total": 100,
  "cache_hits": 0, "cache_misses": 1
}
```

## Library

```python
from exactcount import Problem, Solver, verify_certificate

problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
cid = problem.add_constraint(["x", "y"], [[0, 0], [1, 1], [2, 2]])

solver = Solver(problem)
result = solver.solve(budget=10)          # pauses when budget is exhausted
checkpoint = solver.checkpoint()          # JSON-serializable
solver = Solver.from_checkpoint(checkpoint, problem)
result = solver.solve()                   # unlimited budget -> exact count

problem.remove_constraint(cid)            # revoking constraints is allowed:
solver.solve()                            # stale cache entries are not reused

cert = solver.certificate()
errors = verify_certificate(cert)         # [] means the proof is valid
```

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

The suite brute-force-enumerates all solutions for random problems with up
to 7 variables of 3 values and checks the bounds (and the certificate) at
every pause; it also covers component merge/re-split, constraint revocation
increasing the count, cache key collisions and stale-entry rejection,
budget 0 / exactly-fitting budgets, repeated one-unit-budget resumes across
processes, and rejection of tampered certificates.
