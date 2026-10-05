# licchk

License-branch selection over a reachable dependency graph. Pure Go standard
library.

## Model

- `Graph` maps a package to its direct dependencies. `Reachable` computes the
  set reachable from an entry package; cycles are handled via a visited set.
- License expressions (`ParseExpr`) support `AND` and `OR` (AND binds
  tighter), e.g. `MIT OR (Apache-2.0 AND BSD-3-Clause)`. `Options` enumerates
  the concrete license sets an expression can yield.
- `Policy` declares compatibility constraints: forbidden licenses and
  unordered incompatible license pairs (checked both within one package's
  chosen set and across packages).
- `Solve` picks one branch per reachable package (at most `MaxPackages` = 20)
  with branch-and-bound, minimizing the number of *exceptions* — packages
  that cannot be brought into compliance. Unreachable packages are never
  inspected and never reported.

## Certificate

`Solve` returns a `Certificate`: the reachable set, the chosen option index
and concrete license set per compliant package, and the sorted exception
list. `Certificate.Verify` re-checks it against the problem: reachable-set
equality, partition into choices/exceptions, branch validity, and absence of
any policy violation.

## Exhaustive cross-check

`solveExhaustive` explores the full assignment tree without pruning.
`TestSolveMatchesExhaustive` compares the solver against it on 300 seeded
random instances (cyclic graphs, unreachable violators, random policies).

## Test

```sh
go test ./...
```
