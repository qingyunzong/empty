# Incremental Template Materializer

Offline, single-machine Node.js 22 library + CLI. Standard library only;
tests use `node:test`.

## Template language

- Plain text passes through verbatim.
- `{{ expr }}` interpolation. Expressions: variables, `a.b.c` field access,
  numbers, `'string'` / `"string"`, `+ - * / %`, unary `-`, parentheses,
  and filters `expr | name` / `expr | name(arg, ...)`
  (`upper`, `lower`, `trim`, `length`, `abs`, `json`).
- `{% scope x = expr %}...{% end %}` opens a nested scope binding `x`;
  `{% scope x %}` (no initializer) rebinds `x` to its current outer value.
  Inner bindings shadow outer ones; leaving the block restores them.
  A missing field on any object fails the render.

## Pipeline

1. `src/lexer.js` — two-mode lexer switching between text and expression modes.
2. `src/parser.js` — template parser + Pratt expression parser
   (precedence: `|` filters < `+ -` < `* / %` < unary `-` < `.` field access).
3. `src/compiler.js` — compiles the AST to flat stack-machine bytecode.
4. `src/vm.js` — executes bytecode block by block inside an isolated
   `node:vm` context (scope chain + filter table live in the sandbox;
   templates can only ever run the fixed bytecode ops, never host code).
5. `src/versions.js` — immutable version store: every patch produces a new
   frozen snapshot; `undo`/`redo` only move the cursor. The normalized hash
   is SHA-256 over canonical JSON (recursively sorted keys) of
   `{ template, variables }`.
6. `src/materialize.js` — compile + render orchestration.

## Atomicity / rollback

Any failure — undefined variable, missing field, unsupported filter type,
unclosed block — aborts the whole materialization. The render buffers
(pending + committed) are discarded; no partial output escapes, and the
current patch version is left unchanged.

## CLI

```
node src/cli.js [input.json]     # or pipe JSON on stdin
```

Input:

```json
{
  "template": "{{ greeting }}, {{ name }}!",
  "variables": { "greeting": "hi" },
  "patches": [ { "set": { "name": "world" } }, { "op": "undo" }, { "op": "redo" } ]
}
```

Patches: `{ "set": { "a.b": v } }`, `{ "unset": ["a.b"] }`, `{ "op": "undo" }`,
`{ "op": "redo" }`. Output is a single JSON line:
`{ ok, version, hash, output }` on success (exit 0) or
`{ ok, false, version, hash, error }` on failure (exit 1, no partial output).

## Tests

```
node --test
```

Real recorded result (Node v22.22.1, 2026-10-02):

```
ok 1 - test/expr.test.js
ok 2 - test/failure.test.js
ok 3 - test/resolution.test.js
ok 4 - test/shadowing.test.js
ok 5 - test/versions.test.js
# tests 5
# pass 5
# fail 0
```

Acceptance coverage:

- `test/shadowing.test.js` — three-level shadowing renders the
  hand-computed text `outer|mid|inner|mid|outer`.
- `test/versions.test.js` — patch adds `name`, undo then redo: hash and
  rendered output are identical across the redo; versions are frozen
  snapshots; hash is key-order independent.
- `test/failure.test.js` — deep missing field (`user.profile.contact.email`)
  fails the whole render; the CLI failure payload contains no partial
  rendered text and the version stays put.
- `test/resolution.test.js` — variable resolution paths (which scope frame
  each load resolves to) are traced and compared against a hand-enumerated
  table.

Note: the CLI is tested in-process via `runCli()` because this sandbox
forbids Node from spawning child processes (EPERM); end-to-end stdin/stdout
behavior was verified manually with `echo '{...}' | node src/cli.js`.
