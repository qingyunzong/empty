# mini-csp-solver

A small finite-domain CSP solver in TypeScript using only Node.js built-in
modules (zero runtime dependencies).

## Features

- **Up to 16 variables** (`MAX_VARS`), each with a finite domain of 1–31
  integer values `0..d-1` (domains are bitmasks internally).
- **Constraints**:
  - `allDifferent(...vars)` — singleton-based propagation plus clash detection.
  - `table(scope, tuples)` — allowed-tuples constraint with GAC (generalized
    arc consistency): unsupported values are pruned.
- **Propagation with full undo**: every domain narrowing is recorded on a
  trail; undoing a branch restores **all** domains exactly.
- **Node budget**: search counts branching nodes; when the budget runs out the
  solver stops and reports the open frontier.
- **Three outcomes** (`SolveResult.status`):
  - `"sat"` — solution(s) found (`solution`, `solutionCount`).
  - `"unsat"` — the search tree was fully explored; complete infeasible tree
    (`nodes` counts the whole tree, `frontier === 0`).
  - `"unknown"` — budget exhausted; `frontier` reports the number of open
    (unexplored) nodes.
- **Independent cross-check**: `enumerateBruteForce` enumerates the full
  Cartesian product without propagation and is used in tests to verify the
  solver's solution counts.

## Usage

```ts
import { Solver, allDifferent, table } from "./src/solver";

const solver = new Solver([4, 4, 4, 4]); // 4 vars, values 0..3
solver.addConstraint(allDifferent(0, 1, 2, 3));
solver.addConstraint(table([0, 3], [[0, 3], [1, 2], [2, 1]]));

const result = solver.solve("all");        // or "first", optional node budget
// result: { status, solution, solutionCount, nodes, frontier }

const partial = solver.solve("all", 100);  // node budget -> may be "unknown"
```

## Tests

```
npm test    # tsc build + node --test
```

### Actual results (Node v22.22.1, tsc 7.0.2, 2026-10-05)

All 12 tests pass (`# pass 12`, `# fail 0`):

```
ok 1 - rejects more than 16 variables
ok 2 - allDifferent over 4 vars/domain 4 yields all 24 permutations
ok 3 - table constraint count matches brute-force enumeration
ok 4 - mixed allDifferent + table matches brute force on random instances
ok 5 - undoing branches restores all domains exactly
ok 6 - unsatisfiable instance reports a complete infeasible tree
ok 7 - node budget yields an open frontier, larger budget closes it
ok 8 - budget of zero explores nothing and reports frontier
ok 9 - first-solution mode returns a valid solution
ok 10 - 16-variable allDifferent solves quickly via propagation
ok 11 - GAC on table prunes unsupported values before search
ok 12 - invalid constraints are rejected
```

Notable checks:

- Test 2/3/4 verify solver counts against `enumerateBruteForce` (24
  permutations for 4×4 allDifferent; 25 randomized mixed instances).
- Test 5 snapshots all domains before `solve("all")` and asserts they are
  identical afterwards — undo restores everything.
- Test 6 uses a pigeonhole instance (3 vars, 2 values, allDifferent) which is
  unsatisfiable with a fully explored tree (`frontier === 0`).
- Test 7/8 show a small budget yields `status: "unknown"` with
  `frontier > 0`, while an unbounded run closes the tree (5! = 120 solutions).
- Test 10 solves a 16-variable allDifferent in ≤ 16 nodes thanks to
  propagation.

## Layout

- `src/solver.ts` — solver, constraints, brute-force enumerator.
- `test/solver.test.ts` — test suite (`node:test` + `node:assert/strict`).
- `types/node-shims.d.ts` — minimal type declarations for the Node built-ins
  used in tests (avoids a `@types/node` download).
