# ammo-alloc-sim

Simulation tool that assigns integer ammunition rounds (up to 4 ammo types)
to up to 10 targets under a total round budget (<= 20). Target damage comes
from a discrete input table `damage[target][ammo][rounds]`; no linearity or
monotonicity is assumed. The tool maximizes the total value of defeated
targets (damage >= threshold), breaking ties toward fewer rounds fired, and
prints an evaluation table. A full-enumeration reference (every allocation
vector) cross-checks the optimizer on small instances.

## Build and test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## Usage

```sh
./build/simtool scenarios/example.txt --verify
```

- `--verify` enumerates every allocation vector `x[target][ammo]` with
  `sum <= budget` and compares the optimum (value, then rounds) with the
  solver. Refused when the vector count exceeds `--max-leaves` (default 50M).

## Scenario format

One directive per line; `#` starts a comment.

```
budget <0..20>
ammo <1..4>
target <value> <threshold> [name...]
damage <target_idx> <ammo_idx> <rounds> <damage>
```

Unspecified damage entries default to 0. Damage dealt to a target is the sum
over ammo types of the table entries for the rounds fired at that target.

## Method

1. Per target, enumerate all compositions of `<= budget` rounds into the ammo
   types against the discrete table to find the minimal rounds (and the
   achieving allocation) needed to reach the threshold.
2. Solve a 0/1 knapsack over targets (capacity = budget, item weight = minimal
   rounds, item value = target value), maximizing value then minimizing rounds.

This decomposition is exact because damage on a target depends only on the
rounds assigned to that target. The brute-force reference in
`src/bruteforce.cpp` verifies this claim independently.
