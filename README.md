# ifacecheck

Structural subtyping checker for finite interface type graphs. Reads type
declarations and `check A <: B` queries from a file (or stdin), then decides
compatibility with a coinductive greatest-fixed-point algorithm.

## Usage

```
go run . examples/list.typ
cat input.typ | go run .
go test ./...
```

Exit code: `0` all checks compatible, `1` some check incompatible,
`2` parse error or reference-model disagreement.

## Input language

```
type IntList = interface {
	Head: int
	Tail: IntList
	Map(f: func(int) int): IntList
}
check IntList <: IntListRead
```

- Types: `interface { ... }`, `func(T, U) R`, named references, primitives
  (`int`, `int64`, `string`, `bool`, `float64`, `byte`, `rune`), and `any`.
- Members: fields `Name: Type` and methods `Name(p: T): R` (desugared to
  func-typed members). Newlines or `;` separate members and declarations.
- Named types may be recursive or mutually recursive; references form a
  cyclic graph. `type A = A` (a bare cyclic alias) is rejected.

## Subtyping rules

- Interface members (fields) are covariant; extra members are allowed.
- Function parameters are contravariant, results covariant.
- `any` is the top type; primitives match by name.
- Recursion is handled coinductively: a pair of types is compatible unless
  a finite witness of incompatibility exists (greatest fixed point).
  The search is breadth-first, so a reported failure lies on a shortest
  member path, e.g. `.Map(arg 0)(result)`.

## Reference model

With `-verify` (default), acyclic types are expanded to finite trees and
re-checked by a plain structural recursion (`TreeCheck`); the coinductive
result must agree. Cyclic types have no finite expansion and are skipped.
