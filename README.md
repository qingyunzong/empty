# minicore-sat

Exhaustive solver for named boolean constraints, written in TypeScript on top
of Node.js built-in modules only (zero npm dependencies; `tsc` is the only
build tool).

## What it does

- Merges named boolean constraints from CLI arguments, a JSON file, and named
  assumptions into one set, capped at **18 named constraints** and **18
  distinct variables** (explicit exhaustive-search limits; `cli limits`
  prints them). Anything larger is rejected with an explicit error.
- **Satisfiable**: returns the lexicographically smallest assignment
  (variables sorted ascending, `false < true`).
- **Unsatisfiable**: returns a minimum-cardinality unsatisfiable subset
  (core); ties are broken by the lexicographically smallest sorted ID list.
  Minimality is proven by independently checking that **every strictly
  smaller subset is satisfiable**, and an unsatisfiability **proof tree**
  (a complete case split whose leaves are falsified core constraints) is
  printed.
- **Named assumptions** can be added/removed between runs. A **minimal
  conflict cache** is kept in the state file; after an assumption is
  retracted, an old conflict is reused only if **all of its sources still
  exist** in the current merged input (and it is re-validated against the
  truth table before use, so corrupt entries are never trusted).
- **Pausable solving**: `--step-limit N` stops the subset search and
  persists the frontier (current subset size + next combination) to the
  state file; `resume` continues exactly where it stopped.
- **Independent verification**: `verify` re-checks the stored result using
  only a naive per-assignment evaluator (never the solver's bigint masks):
  the core's full truth table, every smaller subset, the proof tree
  structure, the lex-minimality of SAT assignments, and the soundness of
  every reusable cache entry.

## Expression syntax

```
!a  ~a  not a          negation
a & b  a && b          conjunction
a | b  a || b           disjunction
a ^ b  a xor b          exclusive or
a -> b  a implies b     implication (right associative)
a <-> b  a iff b        equivalence
( ... )                  grouping
true false 1 0           constants
```

Precedence (loosest first): `<->`, `->`, `|`/`^`, `&`, `!`.

## Usage

```sh
npm run build            # tsc -> dist/
npm test                 # compile + run the test suite

node dist/src/cli.js solve "c1=a | b" "c2=!a | c"     # SAT -> lex-min assignment
node dist/src/cli.js solve "c1=a" "c2=a" "c3=!a"      # UNSAT -> core {c1,c3} + proof tree
node dist/src/cli.js solve --file constraints.json    # merge constraints from JSON
node dist/src/cli.js solve ... --step-limit 100       # pause + persist frontier (exit 3)
node dist/src/cli.js resume                           # continue the paused run
node dist/src/cli.js assume add h1 "x & y"            # named assumption
node dist/src/cli.js assume remove h1                 # retract (cache entries stay, but
                                                      #   stop being reusable)
node dist/src/cli.js assume list
node dist/src/cli.js verify                           # independent verification
node dist/src/cli.js limits                           # print the exhaustive bounds
```

State (assumptions, conflict cache, paused frontier, last result) lives in
`.minicore-state.json` (override with `--state <path>`).

## How it works

- Each constraint is compiled to a **bigint truth mask** over the sorted
  variable list: bit `a` is set iff the constraint holds under assignment
  `a`. A subset is unsatisfiable iff the AND of its masks is `0n`, and the
  lowest set bit of the joint mask is the lexicographically smallest
  satisfying assignment.
- The subset search enumerates sizes `k = 1, 2, ...` and, within each size,
  combinations in lexicographic order of the sorted names — so the first
  unsatisfiable subset found is simultaneously minimum-cardinality and
  lexicographically smallest. A combination is a plain `number[]`, which is
  what makes the paused frontier trivially serializable.
- The verifier (`src/verify.ts`) never touches the mask machinery; it
  re-evaluates everything with a plain recursive evaluator, so a mask bug
  cannot validate itself.

## Tests

`npm test` compiles with `tsc` and runs 37 subtests across 4 files
(expression/mask cross-checks on 300 random expressions, solver semantics,
cache/assumption rules, pause/resume equivalence, verifier tamper
detection, and CLI end-to-end). The actual recorded output is in
`TEST_RESULTS.txt` — **37 passed, 0 failed** (Node v22.22.1, tsc 7.0.2).
