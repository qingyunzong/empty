# loop-analyzer

Control-flow-graph loop analyzer (C++20). It identifies strongly connected
cycles, separates natural single-entry loops from multi-entry irreducible
loops, prints nested natural loops by containment, and can eliminate
irreducible loops by node splitting — on a copy, never mutating the input.

## Build & test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## Usage

```sh
loop-analyzer FILE [--entry NAME] [--split]
```

Input format, one statement per line (`#` starts a comment):

```
entry: A        # optional; --entry overrides; default: first node seen
A -> B          # edge ("A B" also works)
C               # isolated node declaration
```

Output sections: graph summary, cyclic SCCs, back edges, natural loops
(indented by containment depth, outer loops first), and irreducible loops
with their entry nodes. `--split` additionally prints the analysis of the
node-split graph, in which every irreducible loop has been duplicated per
entry (copies named `X#0`, `X#1`, ...), making the flow graph reducible.

## Verification approach

For small graphs the test suite cross-checks the fast iterative dominator
computation against a brute-force reference (d dominates v iff removing d
makes v unreachable from the entry), and natural-loop bodies — including
loops with multiple back edges into one header — against full-reachability
reference sets, over hundreds of randomized graphs plus targeted cases.
