# linck — offline linearizability checker

`linck` decides, fully offline and on a single machine, whether the batch
operation histories uploaded by multiple terminals admit a serial
explanation consistent with causality. It is written in plain JavaScript
for Node.js 22 and uses only the standard library.

```
node bin/linck.js check rules.dsl history.jsonl --json out.json
node bin/linck.js verify out.json
node --test          # run the test suite
```

## Verdicts

| Verdict | Meaning |
|---|---|
| `LINEARIZABLE` | A serialization exists that respects causal order, real-time order and the declared commutativity rules, and is valid for the object model. |
| `NON_LINEARIZABLE` | No such serialization exists (constraint contradiction or search exhausted without a witness). |
| `UNKNOWN` | Required events are missing: an invocation without a response, a dangling `prev` reference, or a correction whose target event is absent. `UNKNOWN` is **never** used for contradictions or search failure. |

## History format (JSONL)

One JSON object per line. Operation events:

```json
{"id":"e1","node":"n1","prev":null,"invocation":1,"response":5,"realTime":1,"op":"write","key":"x","value":1}
```

- `id` (string, unique), `node` (string), `op` (string), `key` (string), `value` (any JSON) — required.
- `invocation` / `response` (numbers) — the operation's time interval. `response: null` (or absent) marks a pending operation and yields `UNKNOWN`.
- `prev` — id of the causally preceding event (session order), or `null`.
- `realTime` — wall-clock time of the record; orders corrections.

Correction events replace the `op`/`key`/`value` of an earlier event and
produce a new history version (applied in `realTime` order, ties by `id`):

```json
{"id":"c1","corrects":"e2","realTime":10,"op":"read","key":"x","value":2}
```

Each version is checked independently; all but the latest version keep
their verdicts with status `SUPERSEDED` in the certificate.

Malformed lines (bad JSON, missing/ill-typed fields, duplicate ids,
undeclared ops) are reported with a line number and exit code 2.

## Rule DSL

```
op write(key: string, value: any) sets key = value
op read(key: string) -> any gets key

rule register {
  let threshold = 10
  commutes write(k, _), write(k, _)
  happens-before write(k, v), read(k) when a.response + threshold <= b.invocation
  concurrent write(k1, _), read(k2) when k1 != k2
}
```

- **op declarations** give parameter types (`int`, `string`, `bool`,
  `any`), an optional return type, and an optional effect: `sets k = v`
  (state update) or `gets k` (observes state; the observed value is the
  event's `value` field, `null` for a never-written key). Ops without an
  effect are state-neutral.
- **Patterns** match events positionally: literals, `_` wildcards, binding
  variables (repeated variables across both patterns enforce equality),
  regex literals `/user:.*/`, and wildcard strings `"tmp:*"`.
- **Expressions** are parsed by a Pratt parser: `and`/`or`/`not`,
  comparisons, arithmetic, field access (`a.key`, `a.value`,
  `a.invocation`, …), regex match `=~`, and the builtins
  `happens-before` / `concurrent` / `commutes`, usable both infix
  (`a happens-before b`) and in call form. Inside a constraint's `when`,
  `a` and `b` refer to the two matched events.
- **Lexical scoping**: `let` bindings live in their block; nested blocks
  may shadow. Lets are constant-folded at compile time.
- **Static type checking** validates pattern literals against declared
  parameter types, operand types, arity, and variable scopes; errors carry
  line numbers and exit with code 2.

Rules compile to stack-machine bytecode (`src/compile.js`,
`src/vm.js`). Constraint semantics:

- `commutes P, Q [when E]` — matching event pairs are order-independent:
  a candidate serialization is valid if any sequence reachable by swapping
  adjacent commuting pairs is register-valid (commutation closure).
- `happens-before P, Q [when E]` — adds an ordering edge `a -> b`.
- `concurrent P, Q [when E]` — cancels the real-time edge between the pair.

Built-in ordering constraints, always active:

- **causal**: `prev` chains contribute edges.
- **real-time**: `e1.response <= e2.invocation` implies `e1 -> e2`.

A cycle in the combined constraint graph is `NON_LINEARIZABLE`.

## Certificates (`out.json`)

Self-contained JSON: per version it embeds the verdict, status
(`CURRENT`/`SUPERSEDED`), the certificate, and a replay section (events,
edges, commutation pairs) so `verify` can re-check everything offline.

- `LINEARIZABLE` → `certificate.serialization`: the witness event order.
- `NON_LINEARIZABLE` → `certificate.counterexample`: the canonical
  shortest non-linearizable subset — smallest size, ties broken by
  lexicographic order of the sorted event ids, listed sorted by id
  (`minimal: true` for histories of ≤ 12 events; larger histories use
  greedy 1-minimality with `minimal: false`).
- `UNKNOWN` → `certificate.pending` / `danglingPrev` /
  `missingCorrectionTarget`.

`verify out.json` re-validates: permutation and edge compliance of
serializations, commutation-closure validity, replay of non-linearizable
versions with the independent full-permutation reference implementation,
canonical minimality of counterexamples, pending-event consistency for
`UNKNOWN`, and version status integrity.

## Exit codes (measured)

| Command | Code | Condition |
|---|---|---|
| `check` | 0 | verdict `LINEARIZABLE` |
| `check` | 1 | verdict `NON_LINEARIZABLE` |
| `check` | 3 | verdict `UNKNOWN` |
| `check` | 2 | DSL/history format error (line number on stderr) or usage error |
| `verify` | 0 | certificate valid |
| `verify` | 1 | certificate invalid |
| `verify` | 2 | malformed certificate file or usage error |

## Architecture

```
src/lexer.js        lazy tokenizer (regex literals re-scanned in pattern context)
src/parser.js       Pratt parser: op decls, rule blocks, patterns, expressions
src/typecheck.js    static types, lexical scopes, event-field checks
src/compile.js      AST -> bytecode constraints; let constant folding
src/vm.js           stack VM for when-expressions and builtins
src/semantics.js    JSON equality, register validity, commutation closure
src/checker.js      constraint graph, topological search, canonical counterexamples
src/reference.js    independent full-permutation reference implementation
src/history.js      JSONL parsing, correction version chain
src/certificate.js  out.json construction and verification
src/cli.js          check / verify commands, exit codes
```

The main checker enumerates topological orders of the constraint graph and
tests each with commutation-closure validity; the reference implementation
independently enumerates all `n!` permutations and filters by the
constraints. The test suite cross-checks both on 450 seeded random
histories of ≤ 8 operations.

Search limits: the main checker explores at most 2,000,000 leaf
serializations and commutation closures at most 200,000 permutations per
candidate; both limits are shared with the reference implementation so
verdicts stay consistent. Counterexample minimization is exhaustive for
≤ 12 events.

## Tests

`node --test` — **57 tests, 57 passed, 0 failed** (Node v22.22.1), covering:

- lexer/parser/typechecker incl. line-numbered errors and lexical scoping
- acceptance ① concurrent commutative writes are linearizable
- acceptance ② causal cycles are non-linearizable (never `UNKNOWN`)
- acceptance ③ missing responses yield `UNKNOWN`
- acceptance ④ corrections change the verdict; old certificates become `SUPERSEDED`
- acceptance ⑤ agreement with the full-permutation reference on ≤ 8 ops
- acceptance ⑥ tied shortest counterexamples resolve by event-id order
- CLI exit codes, certificate output, `verify` round-trips and tamper detection

## Examples

```
node bin/linck.js check examples/register.dsl examples/linearizable.jsonl --json out.json
node bin/linck.js check examples/register.dsl examples/cyclic.jsonl
node bin/linck.js check examples/register.dsl examples/pending.jsonl
node bin/linck.js check examples/register.dsl examples/corrections.jsonl
node bin/linck.js verify out.json
```
