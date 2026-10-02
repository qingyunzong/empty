# causallint

Offline checker that decides whether batched operation histories uploaded
from multiple terminals admit a serialization consistent with causality.
Pure Node.js 22 standard library, fully offline, no dependencies.

## Usage

```sh
node bin/cli.js check rules.dsl history.jsonl --json out.json
node bin/cli.js verify out.json
node --test
```

`check` prints one line per history version plus the final verdict, and
optionally writes a self-contained JSON report (rules + history embedded).
`verify` re-runs the full pipeline from the report's embedded inputs and
validates every certificate.

## Exit codes (actual, verified by test/cli.test.js)

| Code | `check`              | `verify`                    |
|------|----------------------|-----------------------------|
| 0    | `LINEARIZABLE`       | certificate valid (`OK`)    |
| 1    | `NON_LINEARIZABLE`   | certificate invalid         |
| 2    | format/usage error   | malformed report / usage    |
| 3    | `UNKNOWN`            | —                           |

Format errors always carry file and line (and column where applicable),
e.g. `history.jsonl:2: error: invalid JSON: ...` or
`rules.dsl:3:26: error: operator < requires int operands, got int and string`.

## Verdicts

- `LINEARIZABLE` — a serialization exists that respects causal order,
  real-time order and the commutativity constraints, and satisfies per-key
  register semantics. Certificate: `{"kind":"serialization","order":[...]}`.
- `NON_LINEARIZABLE` — the constraints/semantics are contradictory.
  Certificate: a `cycle` (constraint cycle) or the shortest
  `counterexample` subset; ties between equally short counterexamples are
  broken by ascending event id.
- `UNKNOWN` — **only** when required events are missing (an operation
  without a response, or a `prev` link to an absent event). It is never
  used for contradictions or search failure.

## History format (JSONL)

One operation per line:

```json
{"invocation":"e1","response":"r1","node":"n1","prev":"e0","realTime":[0,5],"op":"write","key":"x","value":1}
```

- `invocation` (required): invocation event id. `response`: response event
  id; absent means the operation is pending → `UNKNOWN`.
- `prev`: id or list of ids of causally preceding invocations.
- `realTime`: `[invocationTime, responseTime]` (or a single number, or a
  one-element array for pending operations).
- `op`, `key`, `value`: operation name, key, and argument/return value.
  For `read`, `value` is the observed value; for `write`, the written one.

A correction event replaces an old operation and produces a new history
version; older verdicts are kept with status `SUPERSEDED`, the latest is
`CURRENT`:

```json
{"op":"correct","corrects":"e2","replacement":{"op":"read","key":"x","value":1,"realTime":[2,3],"response":"r2"}}
```

## Rules DSL

```
rule Register {
  op write(key: string, value: int) -> string;   # typed op declarations
  op read(key: string) -> int;

  let bothWrites = a.op == op"write" and b.op == op"write";

  commutes(a, b): bothWrites and a.key == b.key;
  concurrent(a, b): a.key != b.key;
  happens-before(a, b): a.op == op"write" and b.op == op"read"
    and a.node == b.node and a.key == b.key and a.value == b.value;
}
```

- **Lexer**: operation patterns `op"w*"` and key patterns `key"user-?"`
  are first-class literals (glob matching with `*` and `?`); `#` comments.
- **Parser**: Pratt parser; precedence `not` > `and` > `or`, comparisons
  (`== != < <= > >=`), field access `a.op`, `a.key`, `a.value`, `a.node`,
  `a.time`, parentheses.
- **Static types**: `int | string | bool | pattern | any`; comparisons are
  type-checked (`string == pattern` is a glob match), predicate bodies must
  be boolean, errors carry line/column.
- **Scoping**: rule blocks are lexical scopes; `let`s are visible after
  their declaration and are resolved at the use site; predicate binders
  `(a, b)` form an inner scope shadowing outer `let`s.
- **Compilation**: predicates compile to bytecode for a stack VM with
  short-circuit jumps (`push/pushpat/field/cmp/not/jz/jt`).

## Constraint semantics

An edge `i ≺ j` is added when:

- **real-time**: `response_i.time < invocation_j.time`, unless the pair is
  exempted by a `concurrent` or `commutes` rule (either direction);
- **causal**: `j.prev` mentions `i`;
- **happens-before**: a rule predicate holds for `(i, j)`.

A history is linearizable iff some total order of the completed operations
extends these constraints and satisfies register semantics per key (a
`read` observes the most recent `write` to its key, initially `null`).
The search is a memoized backtracking over (placed-set, last-writes);
`test/reference.js` is an independent all-permutations reference used to
cross-check it.

## Layout

- `src/lexer.js`, `src/parser.js`, `src/types.js` — DSL front end
- `src/bytecode.js` — rule compiler + stack VM
- `src/history.js` — JSONL parsing, corrections → versions
- `src/checker.js` — constraints, cycle detection, serialization search,
  minimal counterexamples
- `src/verify.js` — report building/verification
- `bin/cli.js` — CLI (also importable: `main(argv)` returns the exit code)
- `examples/` — runnable scenarios (linearizable, cycle, missing, correction)

## Tests

```sh
node --test
```

Latest run on Node v22.22.1: **29 test cases, 29 passed, 0 failed**
(6 files, incl. the helper `test/reference.js` which contains no tests).
Coverage maps to the acceptance criteria:

1. `test/acceptance.test.js` — commuting writes linearizable (with and
   without the `commutes` rule), causal cycle → `NON_LINEARIZABLE`,
   missing response → `UNKNOWN`, correction flips the verdict with the old
   certificate `SUPERSEDED`, tied shortest counterexamples ordered by
   event id.
2. `test/reference.test.js` — 400 seeded random histories of 2–8
   operations across four rule variants, verdicts identical to the
   all-permutations reference.
3. `test/cli.test.js` — real exit codes 0/1/2/3, `--json` reports,
   `verify` accepting valid and rejecting tampered reports, line-numbered
   format errors.
