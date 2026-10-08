# matchcheck

`matchcheck` analyzes match expressions over finite enums, tuples and
wildcard patterns.

Given a scrutinee `Type` (`Enum`, `Tuple`, or `Unknown`) and a list of
`Branch` values, `Check` reports:

- **Unreachable branches**: arms whose values are all already covered by
  earlier unguarded branches.
- **Minimal uncovered witnesses**: the smallest set of patterns describing
  the values no unguarded branch covers.

Semantics:

- **Guards never guarantee coverage.** A guarded branch is checked for
  reachability but does not shrink the uncovered set.
- **Unknown types are never exhaustive.** If the scrutinee type mentions
  `Unknown` anywhere, `Report.Exhaustive` is always false.
- **Budget.** The `budget` argument caps the tracked witness-set size and
  the value count for enumeration. Exceeding it sets `Report.OverBudget`
  and abandons coverage claims.
- **Small types are verified by enumeration.** When the scrutinee has at
  most `budget` values, every value is enumerated and the witness set is
  confirmed value by value (`Report.EnumVerified`).

## Usage

```go
boolT := matchcheck.Enum{Name: "Bool", Variants: []string{"False", "True"}}
rep, err := matchcheck.Check(boolT, []matchcheck.Branch{
    {Pattern: matchcheck.Variant{Name: "True"}},
}, 64)
// rep.Exhaustive == false
// rep.Uncovered == [Variant{False}]
```

## Test

```sh
go test ./...
```
