# path-rules

Decide whether two path patterns share a common path. If they do, produce
the **witness with the fewest segments**, breaking ties by **byte order** of
the joined path. Optional **exclude patterns** further constrain the
witness, and a **short-domain exhaustive check** can independently accept
the reported shortest witness.

TypeScript + Node.js built-in libraries only (no runtime dependencies).

## Pattern syntax

Segments are joined by `/`:

| segment | meaning                                   |
| ------- | ----------------------------------------- |
| `abc`   | literal, lowercase letters `[a-z]+` only  |
| `*`     | matches exactly one segment               |
| `**`    | whole segment, matches zero or more       |

Rules enforced by the parser:

- empty segments are rejected: `""`, `/a`, `a/`, `a//b`
- partial wildcards are rejected: `a*`, `*b`, `***`
- at most **12 segments per pattern**, at most **10 exclude patterns**

## Usage

```sh
npm run build          # compile TypeScript to dist/
node dist/src/cli.js <patternA> <patternB> [options]
```

```
options:
  --exclude <pattern>   exclude pattern (repeatable, at most 10)
  --budget <n>          max search states before "unknown" (default 200000)
  --verify [n]          accept the result by exhausting the short domain
  --json                print the result as JSON

exit codes: 0 common, 1 disjoint, 2 unknown, 64 usage error
```

### Examples (actual output)

```console
$ node dist/src/cli.js 'a/**' '**/b' --exclude a/b --exclude a/a/b --verify
status: common
witness: a/b/b
segments: 3
expansions: 28
verified: yes (shortest witness accepted by exhaustive domain)

$ node dist/src/cli.js '**' '**' --exclude '**'
status: disjoint

$ node dist/src/cli.js 'a/**' '**/b' --budget 1
status: unknown        # budget exhausted: unknown, not "disjoint"

$ node dist/src/cli.js 'a//b' 'c'
error: empty segment in pattern "a//b"   # exit code 64
```

## How it works

- **Product-automaton search** (`src/search.ts`): best-first search
  (Dijkstra over `(segment count, byte order)`) over pairs of pattern
  positions. `**` may skip (zero segments) or consume one segment; literal
  vs wildcard pins the literal; wildcard vs wildcard branches over the
  symbolic alphabet.
- **Symbolic segment alphabet** (`src/alphabet.ts`): strings not mentioned
  as literals anywhere are indistinguishable to all patterns, so the search
  frontier ranges over `Literals ∪ {τ}`; τ concretizes to the byte-smallest
  non-literal string. This keeps the frontier finite and checkable.
- **Exclude patterns** are tracked as NFA subset masks (one bitmask per
  exclude) advanced alongside the allows; a candidate is accepted only when
  no exclude mask reaches its end position.
- **Budget**: if the expansion budget is exhausted the result is `unknown`
  — never silently reported as an empty intersection.
- **Short-domain acceptance** (`src/verify.ts`): enumerates every path over
  `Literals ∪ {τ-concretization}` up to `n` segments in
  `(length, byte order)` and returns the first path matching both allows
  and no excludes. A shortest global witness of length `≤ n` always lies in
  this domain, so the exhaustive result must equal the search witness.

## Tests

```sh
npm test     # tsc build + node --test
npm run typecheck
```

Actual result (2026-10-05, Node v22.22.1, tsc 7.0.2):

```
ok 1 - dist/test/cli.test.js          #  6 tests
ok 2 - dist/test/crosscheck.test.js   #  6 tests (incl. 300 randomized
                                      #        search-vs-exhaustion checks)
ok 3 - dist/test/match.test.js        #  2 tests
ok 4 - dist/test/pattern.test.js      #  5 tests
ok 5 - dist/test/search.test.js       # 12 tests
# tests 5
# pass 5
# fail 0
```

31 test cases in total, all passing; `npm run typecheck` is clean.

## Layout

- `src/pattern.ts` — segment model, parser, validation limits
- `src/match.ts` — reference glob matcher (ground truth for exhaustion)
- `src/alphabet.ts` — symbolic alphabet, τ concretization, path ordering
- `src/search.ts` — product-automaton witness search with budget
- `src/verify.ts` — short-domain exhaustive enumeration and cross-check
- `src/cli.ts` — CLI (`runCli` is exported for in-process testing)
- `test/` — `node:test` suites, including a seeded randomized cross-check
