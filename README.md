# rel — exact source-to-target reachability probability

CLI that computes the **exact rational probability** that target `T` is
reachable from source `S` in a directed graph (cycles allowed) whose edges
work **independently** with given rational probabilities. Designed for
graphs with up to 20 edges (solver supports up to 63).

No Monte Carlo anywhere: results are exact fractions, and when a node
budget stops the computation the tool prints **sound lower/upper bounds**
instead of an estimate.

## Build & test

```sh
cmake -B build -S . && cmake --build build -j
cd build && ctest --output-on-failure
```

Requires only a C++20 compiler (arbitrary-precision arithmetic is
implemented in-tree, no external dependencies).

## Usage

```
rel [options] [input-file]        # stdin if no file
  --budget N   max internal decision-diagram nodes (0 = unlimited,
               default 100000); on overflow prints sound [lo, hi] bounds
  --dot FILE   write the decision diagram in Graphviz DOT format
  --verify     cross-check by exhaustive enumeration of all 2^M edge
               states (M <= 26); exits nonzero on mismatch
  --decimal D  fractional digits for decimal printout (default 10)
```

Input format (`#` starts a comment):

```
N M          # vertices, edges
S T          # source, target (0-based)
u v p        # M edge lines; p as '2/3', '0.75' or '1', within [0,1]
```

Example:

```sh
$ ./build/rel --verify tests/data/bridge.txt
P(s~>t) = 15/32
decimal: 0.4687500000
diagram: 8 internal nodes, 11 total
verify: enumeration = 15/32  MATCH
```

Budget abort (bounds, never a guess):

```sh
$ ./build/rel --budget 4 --verify tests/data/big.txt
ABORTED: node budget 4 exceeded
bounds: 427/2500 <= P(s~>t) <= 2497/2500
verify: enumeration = 164159104773/195312500000 within bounds  BOUNDS-OK
```

## How it works

- **Factoring + memoization.** `Rel(G) = p_e·Rel(G | e up) + (1-p_e)·Rel(G | e down)`.
  For directed graphs, "e up" must **not** contract `e` (contraction would add
  a spurious `v→u` connection and overestimate); the edge simply becomes
  certainly-present. The recursion DAG over edge variables *is* the decision
  diagram, emitted with `--dot`.
- **Canonicalization.** At each state, edges that cannot lie on any s–t path
  (given the decided edges) are forced "down" in the memo key, collapsing
  equivalent states. Terminal states: `T` reachable via up-edges only (→ 1),
  or unreachable via up∪undecided edges (→ 0).
- **Budget bounds.** When the node budget is exhausted, unresolved
  subproblems are assigned the interval `[0,1]`; intervals propagate upward
  through the nonnegative branch weights, so the printed `[lo, hi]` provably
  brackets the exact value.
- **Exact arithmetic.** All computation uses in-tree arbitrary-precision
  integers (`src/bigint.hpp`) and normalized rationals (`src/rational.hpp`).
- **Verification.** `--verify` enumerates all `2^M` edge-state subsets over a
  common denominator and compares exactly (or checks the bounds on abort).

## Layout

- `src/bigint.hpp` — arbitrary-precision integers (add/mul/divmod/binary-gcd)
- `src/rational.hpp` — exact rationals in lowest terms
- `src/model.hpp` — graph model + input parser
- `src/solver.hpp` — factoring solver, budget/bounds, DOT output
- `src/enumerate.hpp` — exhaustive 2^M enumeration for verification
- `src/main.cpp` — CLI
- `tests/` — unit & randomized cross-check tests, CLI end-to-end tests (CTest)
