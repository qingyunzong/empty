# wrapfix — 8-bit wrap-aware range fixpoint analyzer

A small abstract-interpretation CLI. It computes a range fixpoint for
programs with 8-bit wrap-around arithmetic and conditional branches,
prints the over-approximated sets, then proves them sound by enumerating
every reachable concrete state.

## Abstract domain

- Each variable maps to a union of disjoint inclusive intervals over
  `[0,255]` (`IntervalSet`, `src/interval_set.h`).
- At most **4 segments** are kept; only when a join would exceed the cap
  is the closest pair of segments merged (filling the gap), so the result
  stays an over-approximation.
- Wrap-around `+`/`-` on an interval is exact: an interval crossing the
  0/255 boundary splits into two segments.
- The fixpoint iteration has **no artificial cap**: the domain is finite
  and joins only grow, so the worklist always terminates
  (`src/analysis.cpp`).

## Verification

`src/verify.cpp` enumerates all reachable concrete configurations
`(pc, env)` — no guessed bound on loop trip counts — and checks each
concrete value is contained in the abstract set at that program point.

## Language

```
label:                # may prefix any instruction
input x               # x ranges over all of [0,255]
x = 5  /  x = y       # constant / copy
x = y + 5             # 8-bit wrap-around add (sub with '-')
if x < 5 goto label   # ops: < <= == != >= >
goto label
halt
```

## Build & test

```
cmake -B build -S . && cmake --build build
ctest --test-dir build --output-on-failure
./build/analyzer examples/wrap7.sl        # add --no-verify to skip checking
```

Exit codes: `0` verification passed, `1` unsound/incomplete, `2` usage or
parse error. See `examples/` for demo programs (wrap-around loops, exact
4-segment joins, and a 5-way join that triggers segment merging).
