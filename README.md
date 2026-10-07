# sreach — exact source-to-target reachability probability

Computes the exact probability that a target vertex is reachable from a source
vertex in a graph whose edges are present independently with rational
probabilities. Cycles are allowed; edges may be directed (default) or
undirected (`--undirected`). Up to 20 edges.

No Monte Carlo: results are exact fractions (arbitrary precision). If the
decision-diagram node budget is exhausted, the tool aborts and prints sound
lower/upper bounds instead — it never pretends an estimate is exact.

## Build & test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## Usage

```sh
./build/sreach [options] [input-file]     # stdin if no file given
  --budget N     max decision nodes before aborting with bounds (default 2000000)
  --undirected   treat edges as undirected
  --verify       cross-check against full 2^m edge-state enumeration
  --dot FILE     write the decision diagram in Graphviz DOT format
```

Input format (`#` starts a comment):

```
n m            # vertices, edges (m <= 20)
s t            # source, target
u v p          # m lines; p = edge-present probability: a/b, integer, or decimal
```

Output: `status: exact` with `probability: p/q`, or `status: budget-exceeded`
with `lower:`/`upper:` bounds. Exit codes: 0 exact, 2 budget exceeded,
1 bad input, 3 verify mismatch.

## Method

The solver builds a binary decision diagram over edge-presence variables by
Shannon expansion: pick an edge on some s-t path, recurse on the contracted
(edge present) and deleted (edge absent) graph, memoize on the
(contracted, deleted) edge-mask pair. The probability is evaluated on the DAG
with exact rational arithmetic. When the node budget runs out, unfinished
leaves are marked `?`; because reachability is monotone in edge states,
evaluating them as 0 (resp. 1) yields a valid lower (resp. upper) bound.
`--verify` enumerates all 2^m edge states and checks the exact value agrees
with the diagram (or lies within the printed bounds).

## Layout

- `src/bigint.hpp` — minimal arbitrary-precision unsigned integer
- `src/rational.hpp` — exact normalized rationals
- `src/solver.{hpp,cpp}` — BDD solver, bounds, enumeration, parser, DOT export
- `src/main.cpp` — CLI
- `tests/` — unit tests (incl. randomized enumeration cross-check) and CLI fixtures
