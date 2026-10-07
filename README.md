# ast-reduce

A test-case reducer for a small S-expression language. It shrinks an input
AST with three local transformations while an external oracle command
confirms the failure still reproduces, and stops at a **1-minimal** result:
no single remaining transformation preserves the failure.

## Language

```
expr := INT | SYM | '(' expr* ')'      ; `;` starts a line comment
```

## Transformations

- `delete_node` — replace any subtree by the literal `0`
- `reduce_int` — drive an integer literal toward `0` (try `0`, then halving)
- `shorten_list` — remove contiguous chunks of list elements (ddmin-style,
  coarse to fine)

Every candidate is syntactically valid by construction and is additionally
re-verified by re-parsing its printed form before each trial
(`--no-validate` disables this). A candidate is kept only if the oracle
exits 0 on it, i.e. the failure genuinely reproduces at every accepted step.
Accepted steps strictly decrease a lexicographic measure
(node count, sum of |integer values|), and `--max-trials` (default 100000)
plus a per-run oracle `--timeout` bound the whole procedure, so reduction
is always finite.

## Bad-predicate verification

Before reducing, the oracle is executed twice (uncached) on the original
input: reduction is refused (exit 2) if the failure does not reproduce or
the verdict is unstable. After reducing, the oracle is re-executed
(uncached) on the result: exit 3 if the failure no longer reproduces.

## Caching

Predicate verdicts are cached by key `<env_id>:<sha1(print(tree))>`, where
`env_id` hashes the oracle command, OS/kernel (`uname`), compiler version,
and an optional `--env-id` tag — cached verdicts are never reused across
execution environments. `--cache-file F` makes the cache persistent.

## Trial trace

The complete trial trace is emitted as JSON Lines (default stderr,
`--trace FILE` for a file): a `start` record (env id, input hash), one
`oracle` record per predicate evaluation (hash, cache hit/miss, verdict),
one `trial` record per attempted transformation (pass, AST path,
transformation, detail, accepted), and a final `done` record (trial count,
`one_minimal` flag).

## Usage

```
ast-reduce --oracle CMD --input FILE [options]
```

`CMD` is run as `timeout SEC CMD <candidate-file>`; exit status 0 means the
failure reproduces. Options: `--output`, `--trace`, `--env-id`,
`--max-trials`, `--timeout`, `--cache-file`, `--no-validate`.

Exit codes: `0` success (1-minimal); `1` usage/IO/parse error; `2` bad
predicate (no repro or unstable); `3` post-reduction check failed; `4`
trial limit reached (result written, not 1-minimal).

## Build and test

```
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

Tests: unit tests for the AST (`ast`), transformations (`transform`), the
environment-keyed cache (`cache`), and the reduction loop including
1-minimality and trace completeness (`reduce`); plus end-to-end CLI tests
for a successful reduction with cache reuse (`cli_reduce_ok`), a predicate
that never reproduces (`cli_bad_predicate`), and a flaky predicate
(`cli_flaky_predicate`).
