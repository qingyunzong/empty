# evq — evidence record query library & CLI

Offline, single-machine, Node.js 22, standard library only.

## Query language

- Bare words, `"quoted phrases"` and `/regex/flags` literals search all
  string fields (case-insensitive substring / regex).
- `field:value`, `field:"phrase"`, `field:/re/` are field predicates.
- `field <op> value` with `= == != < <= > >=` compares typed fields.
- `and`, `or`, `not` (keywords, case-insensitive) and `( )` group
  expressions; juxtaposition is an implicit `and`.
  Precedence: `not` > `and` > `or`.

## Static type checking

- Unknown fields are compile-time errors.
- String predicates (substring/phrase/regex) require `string` fields.
- Ordering comparisons (`< <= > >=`) require `number` or `date` fields.

## Execution

Queries compile to postfix bytecode for a stack VM. Every instruction
costs 1 unit of a fixed budget (default 10000). Exceeding the budget,
an invalid regex, or a type error aborts safely: no partial hits are
returned and engine state (version history) is left unchanged.

Each successful query appends a version; `undo`/`redo` move between
versions. Every version carries a plan certificate: normalized AST
(plus its SHA-256), schema hash, budget and executed instruction count.

## CLI

```
node src/cli.js run --records examples/records.json --schema examples/schema.json \
  --query 'status:open and severity>=4' [--budget N] [--state evq-state.json]
node src/cli.js undo|redo|status [--state evq-state.json]
```

Exit codes: `0` ok, `1` runtime error (budget exceeded), `2` compile
error (parse/type/regex), `3` usage or I/O error.

## Tests

```
node --test
```
