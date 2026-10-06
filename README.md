# loopfind

CLI for static loop analysis of a control-flow graph (C++20).

- Finds cycles via Tarjan SCCs and dominator-based back edges.
- Classifies loops as **natural** (single entry, header dominates the body)
  or **irreducible** (cyclic SCC with multiple entries).
- Nested natural loops are printed as a containment tree.
- `--split` performs node splitting on a **copy** (the input graph is never
  modified) and re-analyzes the reducible result.

## Input format

One directive per line, `#` starts a comment:

```
entry 0
edge 0 1
edge 1 2
```

## Build & test

```
cmake -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## Usage

```
loopfind [--split] <file|->
```

Example output for `tests/data/nested.cfg`:

```
graph: nodes=6 edges=7 entry=0
reachable: 6/6
back-edge: 3 -> 2
back-edge: 4 -> 1
natural-loop header=1 latches={4} body={1 2 3 4}
  natural-loop header=2 latches={3} body={2 3}
irreducible-loop: none
```
