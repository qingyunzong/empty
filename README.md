# rescheck

A static checker for a tiny imperative IR with branches and loops.
A resource created by `new x` must be consumed by `use x` **exactly
once on every path** — including exceptional (`panic`) exits — and
`move y = x` transfers ownership, invalidating `x`.

## Abstract domain

Finite lattice per variable (height 3):

```
      Conflict        states disagree across paths
     /   |    \
  Live Moved Consumed
     \   |    /
       Uninit         no resource ever bound
```

## How it works

- `Analyze` runs a forward worklist dataflow analysis. Transfer
  functions are monotone on the finite lattice, so the iteration
  always reaches a fixed point. Merge points join incoming states;
  genuine disagreement is reported as `merge-conflict`.
- `Expand` enumerates concrete execution paths (loops unrolled up to a
  visit bound), so every violation carries its **violating path** as a
  sequence of block labels.
- `Diagnose` runs both and cross-checks them:
  - merge points: the dataflow in-state must over-approximate the join
    of all concrete entry states (`CheckConsistency`);
  - loops: header states must be stable under one more unrolling
    (`FixedPointReached`).

## Violations

`double-consume`, `use-after-move`, `use-before-init`,
`move-after-move`, `overwrite-leak`, `leak-at-return`, `leak-at-panic`,
`merge-conflict`, `path-dependent-use`, `maybe-leak-at-*`.

## Run

```sh
go test ./...   # unit tests, incl. merge-point and fixed-point checks
go run ./cmd/rescheck
```
