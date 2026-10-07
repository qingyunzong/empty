# oneof-validator

A dependency-free TypeScript schema validator for Node.js (built-in modules
only). Schemas support objects, arrays, integers, `$ref` references and
`oneOf`.

## Schema format

```ts
type Schema =
  | { type: "integer" }
  | { type: "object"; properties?: Record<string, Schema>; required?: string[] }
  | { type: "array"; items: Schema }
  | { oneOf: Schema[] }
  | { $ref: string };            // "#/definitions/<name>"

type RootSchema = Schema & { definitions?: Record<string, Schema> };
```

## Semantics

- **oneOf**: a value passes iff *exactly one* branch validates cleanly.
  Zero matches report `oneOf: no branch matched`; more than one match
  reports `oneOf: ambiguous, branches [...] all matched` at the path of the
  oneOf (the ambiguity path). Branch-internal errors are discarded; only the
  oneOf's own verdict is reported.
- **References**: `$ref` may be recursive (e.g. a linked-list `node` schema
  referencing itself), so circular *schemas* are allowed. Cycles in the
  *data* are rejected with `circular reference in value` at the path where
  the cycle closes. Shared subvalues (DAGs) are accepted, because only the
  containers on the current path count as ancestors.
- **Non-productive recursion**: a `oneOf`/`$ref` cycle that never descends
  into the value (e.g. `d0 = { oneOf: [..., { $ref: "#/definitions/d0" }] }`)
  can never terminate, so it throws a schema error instead of hanging.
  Unresolvable refs and pure `$ref` chains are schema errors too.
- **Error ordering**: errors are sorted by the byte order of their
  JSON-Pointer-encoded paths (UTF-8 byte order, implemented as code-point
  order, which is identical). Array index `10` therefore sorts before `2`,
  and non-ASCII keys sort by their UTF-8 bytes, not locale rules.

## Implementations

- `validate` (`src/validate.ts`) — the production validator. Fully iterative
  (explicit stack with visit/exit/join frames), so 100k-deep values do not
  overflow the call stack; oneOf branches are evaluated by join frames on
  the same stack. Paths are persistent chains, materialized only for errors
  that survive to the result.
- `validateReference` (`src/reference.ts`) — the direct recursive model of
  the same semantics, used as the differential oracle.

## Tests

`npm test` compiles with `tsc` and runs the suite in-process (the sandbox
here disallows child processes, so `node --test`'s per-file subprocesses are
replaced by `test/run.ts`, which drives `node:test` in one process):

- `test/validate.test.ts` — unit tests: integers, objects, arrays, oneOf
  cardinality and ambiguity paths, recursive refs, cyclic data vs DAGs,
  byte-order sorting, schema errors, 100k-deep nesting.
- `test/differential.test.ts` — seeded random schemas/values (including
  recursive definitions, shared references and injected cycles) validated by
  both implementations; results must be identical and sorted. A second
  battery stresses a recursive linked-list schema with cyclic data.

## Actual test results (recorded 2026-10-07, Node v22.22.1, tsc 7.0.2)

```
differential: 1000 cases, valid=490, ambiguous=66, cyclic=1, schemaErrors=18
list differential: 500 cases, cyclic=161
ok 1 - integer accepted, non-integers rejected
ok 2 - object required and nested property paths
ok 3 - array element errors carry numeric index segments
ok 4 - oneOf passes only when exactly one branch matches
ok 5 - oneOf reports the ambiguity path when several branches match
ok 6 - recursive $ref schema validates recursive data
ok 7 - cyclic data is rejected, shared DAG subvalues are allowed
ok 8 - errors are sorted by path byte order, not numeric or locale order
ok 9 - unresolvable and circular $ref chains are schema errors
ok 10 - oneOf/$ref cycle at the same value is a schema error, not a hang
ok 11 - iterative validator handles 100k-deep nesting without stack overflow
ok 12 - reference model agrees on the fixed examples above
ok 13 - iterative validator matches the direct recursive model on random cases
ok 14 - recursive list schema with cyclic and acyclic data matches the model
# tests 14
# pass 14
# fail 0
```
