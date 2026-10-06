# wrapfix — 8-bit wrapping range fixpoint analyzer

A small abstract-interpretation CLI. It computes, for every program point,
an over-approximated set of reachable values for each 8-bit variable.

- **Domain**: union of disjoint intervals over the 8-bit ring. Wraparound is
  represented natively as two segments (e.g. `[250,255] U [0,5]`). At most
  **4 segments** are kept; a 5th segment triggers a merge into the hull
  interval (an over-approximation).
- **Operations**: 8-bit wrapping `+` / `-` by constants, assignments, and
  conditional branches (`< <= == != >= >`) that filter the abstract state.
- **Fixpoint**: chaotic iteration over a finite domain — it always
  terminates, with **no guessed bound on loop trip counts**.
- **Verification** (`--verify`): enumerates *all* concrete reachable states
  (the state space is finite: 256 values per variable) and checks that each
  is contained in the abstract result.

## Language

```
# comment
label:
x = 42            # constant
x = y             # copy
x = y + 3         # wrapping add (mod 256)
x = y - 3         # wrapping subtract (mod 256)
if x < 10 goto label
goto label
halt
```

All variables start at 0 at program entry. Falling off the end halts.

## Build, test, run

```sh
cmake -B build -S .
cmake --build build
ctest --test-dir build --output-on-failure
./build/analyzer --verify examples/count_up.an
```

Exit code is 0 when verification passes, 1 when an abstract state misses a
concrete state, 2 on usage/IO errors.
