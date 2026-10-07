# bool-mus-cli

Exhaustive boolean-constraint tool in TypeScript on Node.js built-in
libraries only (no runtime dependencies).

## What it does

- Merges named boolean constraints from a CLI input file (at most **18**
  named constraints including assumptions — the subset space is
  2^18 = 262144) and at most **20** variables (truth table 2^20 rows).
  Both limits are explicit (`bool-mus limits`) and enforced on load.
- **Satisfiable** input: prints the lexicographically smallest assignment
  (variables sorted, `0` before `1`).
- **Unsatisfiable** input: prints a minimum-cardinality unsatisfiable
  subset; ties are broken by the lexicographically smallest sorted id
  tuple. Minimality is proven by checking *every* smaller subset and
  recording a satisfying witness for each, and is shown as a proof tree.
- **Named assumptions** can be added/removed between solves. Minimal
  conflicts are cached; after an assumption is retracted, a cached
  conflict is reusable only while *every* one of its sources (constraints
  and assumptions) still exists and is active.
- **Pausable search**: `--budget N` bounds the number of truth-table rows
  examined per invocation; the frontier (subset size, combination index,
  row) is persisted to the state file and `resume` continues exactly
  where the search stopped.
- **Independent verification** (`verify`): re-checks the claim with a
  separate evaluator (postfix stack machine instead of the recursive
  evaluator) and a separate subset generator (bitmask enumeration
  instead of recursive combinations): full truth table for the core,
  and satisfiability of all smaller subsets.

## Usage

```sh
npm run build          # compile to dist/
npm test               # build + run the test suite (node:test)

node dist/src/bin.js solve examples/unsat.txt
node dist/src/bin.js solve examples/sat.txt
node dist/src/bin.js verify examples/unsat.txt
node dist/src/bin.js solve examples/unsat.txt --state s.json --budget 100
node dist/src/bin.js resume --state s.json
node dist/src/bin.js assume add h1 '!a' --state s.json
node dist/src/bin.js assume remove h1 --state s.json
node dist/src/bin.js cache list --state s.json
node dist/src/bin.js limits
```

Constraint file format — one `id: <expr>` per line, `#` starts a comment:

```
c1: a | b
c2: !a
c3: !b & (a -> c)
```

Operators: `! ~ not`, `& && and`, `| || or`, `^ xor`, `-> implies`
(right-associative), `<-> iff`, parentheses, constants `true false 1 0`.
Precedence, tightest first: `!`, `&`, `^`, `|`, `->`, `<->`.

## Layout

- `src/parser.ts` — tokenizer + recursive-descent parser
- `src/eval.ts` — recursive evaluator + independent postfix evaluator
- `src/solver.ts` — truth-table scan with step budget and frontier
- `src/mus.ts` — minimum unsatisfiable subset search + proof tree
- `src/cache.ts` — minimal-conflict cache with source-existence validity
- `src/state.ts` — JSON state file (constraints, assumptions, cache, frontier)
- `src/verify.ts` — independent verification (truth table + smaller subsets)
- `src/cli.ts` / `src/bin.ts` — command dispatch / executable entry
