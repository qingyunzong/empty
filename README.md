# Incremental Template Materializer

Offline, single-machine Node.js 22 library + CLI for incremental template
materialization. Standard library only; tests use `node:test`.

## Template language

- Plain text passes through unchanged.
- `{{ expr }}` interpolates an expression: variables, field access (`a.b.c`),
  arithmetic (`+ - * / %`, unary `-`, parentheses) and filters
  (`expr | name`, `expr | name(arg, ...)`). Filters: `upper`, `lower`,
  `trim`, `length`, `join(sep)`.
- `{% scope expr %}...{% end %}` evaluates `expr` to an object and pushes it
  as a new scope; its fields shadow outer bindings inside the block. Blocks
  nest arbitrarily.

## Pipeline

1. `src/lexer.js` switches between text mode and expression mode on
   `{{`/`{%` and produces a token stream.
2. `src/parser.js` is a Pratt parser (precedence: filter < additive <
   multiplicative < unary < field access) producing an AST of text, output
   and scope nodes. Unclosed blocks fail here with `UNCLOSED_BLOCK`.
3. `src/compiler.js` lowers the AST to bytecode (`src/compiler.js` `Op`).
4. `src/vm.js` executes the bytecode in a sandboxed interpreter: a value
   stack plus a scope chain, no host access beyond the whitelisted filter
   registry (`src/filters.js`). Output accumulates in an internal buffer and
   is only released on success, so any failure rolls the whole
   materialization back with no partial output.

## Versioning

`src/versions.js` (`VersionStore`) keeps immutable, deep-frozen snapshots.
Each `applyPatch` (`set` / `delete` / `template` ops) appends a new version
and truncates any redo branch; `undo()` / `redo()` only move the cursor.
Invalid patches are rejected without changing the version.

## Errors (all abort the whole materialization)

`UNDEFINED_VARIABLE`, `MISSING_FIELD`, `FILTER_TYPE`, `UNKNOWN_FILTER`,
`UNCLOSED_BLOCK`, `UNCLOSED_EXPR`, `UNEXPECTED_END`, `TYPE_ERROR`,
`LEX_ERROR`, `PARSE_ERROR`, `INVALID_PATCH`.

## CLI

```
node cli.js input.json        # or pipe JSON on stdin
```

Input: `{ "template", "variables", "patches"?, "undo"?, "redo"? }`.
On success stdout gets one JSON line `{ "version", "hash", "output" }`
where `hash` is the SHA-256 of the canonical (key-sorted) JSON of
`{template, variables, output}`. On failure stdout stays empty and the
error report goes to stderr with exit code 1.

## Tests

```
node --test
```

Latest run: 5 files, 27 tests, 27 passed, 0 failed (Node v22.22.1).
