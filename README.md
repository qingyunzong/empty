# perm-mincover

Minimum-cost subset selection of permission-change candidates subject to
allow/deny samples, with **deny-priority** conflict resolution. At most
**18 candidates** per problem. TypeScript + Node.js built-in modules only
(no runtime dependencies).

## Model

- Each **candidate** is a permission rule: `{ id, cost, effect, matches }`
  where `effect` is `"allow"` or `"deny"` and `matches` lists sample ids.
- Each **sample** is an expected outcome: `{ id, expect }` with
  `expect` in `"allow"` / `"deny"`.
- For a chosen subset `S`, a sample is decided as:
  1. **deny** if any selected matching rule denies it (deny priority),
  2. else **allow** if any selected matching rule allows it,
  3. else **deny** (default deny).
- Goal: the minimum-cost subset whose decisions satisfy every sample.
  Tie-breaks: fewer rules, then lexicographically smallest id list.

## Solvers

- `src/bnb.ts` — branch-and-bound (primary). Prunes via: banned candidates
  (a deny-rule hitting an allow-expected sample can never be selected),
  cost bound, and per-sample satisfiability lookahead.
- `src/bruteForce.ts` — exhaustive enumeration of all `2^n` subsets
  (ground truth). With `n <= 18` this is at most 262144 subsets, so every
  run is cross-checked against full enumeration by default (`--no-verify`
  disables). This verifies both optimality and infeasibility.

## Usage

```sh
npm run build          # tsc -> dist/
npm run cli -- examples/feasible.json
node dist/src/cli.js examples/feasible.json --json
cat examples/feasible.json | node dist/src/cli.js -
```

Exit codes: `0` optimal subset found, `1` infeasible, `2` invalid input.

Output includes: status, total cost, selected subset, candidates that can
never be selected (with reason), **per-sample evidence** (matched rules,
deciding rules, reason), and the brute-force verification line.

## Tests

```sh
npm test               # tsc + node --test dist/tests/*.test.js
```

Covers: decision semantics (deny priority, default deny), input validation
(incl. the 18-candidate limit), hand-computed optima, infeasible cases,
400 randomized instances where branch-and-bound must match brute force
exactly (status, cost, subset), an 18-candidate stress test cross-checked
against all 262144 subsets, and CLI behavior (exit codes, JSON, stdin,
error handling).

## Recorded actual results (this workspace, Node v22.22.1, tsc 7.0.2)

`npm test` — 3 test files, 21 tests, all passing:

```
# tests 3   (files: cli.test.js, model.test.js, solvers.test.js)
# pass 3
# fail 0
```

Per-file: cli 8/8, model 6/6, solvers 7/7 (including
"fuzz: branch-and-bound matches brute force on 400 random instances" and
"stress: 18 candidates, brute force cross-check over all 262144 subsets").

`node dist/src/cli.js examples/feasible.json` (exit 0):

```
Status: OPTIMAL
Total cost: 4
Selected rules (2): r1, r6
Evidence per sample:
  s1: expected=allow, actual=allow - allow rule(s) [r1] matched and no deny rule matched
  s2: expected=deny, actual=deny - deny rule(s) [r6] override allow rule(s) [r1] (deny priority)
  s3: expected=deny, actual=deny - deny rule(s) [r6] matched
  s4: expected=deny, actual=deny - no selected rule matches this sample (default deny)
Verification: brute force enumerated 64 subsets; brute force confirms optimum (cost 4, subset [r1, r6]). OK
(branch-and-bound explored 71 nodes)
```

`node dist/src/cli.js examples/infeasible.json` (exit 1):

```
Status: INFEASIBLE
No subset of the candidates satisfies all samples.
Never selectable (would violate an allow-expected sample):
  r2: deny rule matches allow-expected sample(s): s1
Verification: brute force enumerated 4 subsets; brute force also found no feasible subset. OK
(branch-and-bound explored 3 nodes)
```

## Notes

- `types/node-shims.d.ts` provides minimal type declarations for the Node
  built-ins used, because the sandbox has no network access to install
  `@types/node`. Runtime uses only `node:fs` / `node:process` /
  `node:test` / `node:assert`.
- The CLI core (`src/cliCore.ts`) is a pure function
  `(argv, readInput) -> { code, stdout, stderr }`, so tests exercise the
  full CLI in-process without spawning children.
