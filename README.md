# ifacheck

Analyzes a finite interface type graph (JSON) and answers structural
subtyping queries `Sub <: Super`.

Rules:

- width subtyping: `Sub` may have extra members;
- fields are covariant, method results are covariant, method parameters
  are contravariant;
- `any` is the top type; primitives (`int`, `string`, `bool`, `float64`)
  match only themselves;
- recursive types are decided coinductively (greatest fixed point): pairs
  already on the assumption stack are treated as compatible.

On incompatibility the CLI prints the shortest member path to the failure
(BFS over the obligation graph). Path labels: `.field`, `.method()` for
results, `.method(argN)` for (contravariant) parameters.

With `-verify`, small acyclic types are additionally expanded into finite
trees and checked against an independent reference model; the coinductive
result must agree.

Usage:

    go run . [-verify] input.json   # or '-' / no arg for stdin

Exit code is 1 when any query fails. See `examples/pets.json`.

Test:

    go test ./...
