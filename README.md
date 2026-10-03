# evidence-query

Evidence record query library and CLI for a single-machine, offline Node.js 22
environment. Standard library only; tests use `node:test`.

## Features

- Lexer: whitespace, bare words, quoted phrases, regex literals, logical keywords
- Pratt parser: `and`, `or`, `not`, comparisons (`=`, `!=`, `<`, `<=`, `>`, `>=`),
  `field:value` predicates, parentheses
- Static type checking: unknown fields rejected; string predicates only on
  `string` fields; range comparisons only on `number`/`date` fields
- Query compiled to bytecode and executed on a stack VM with a fixed
  instruction budget; budget overflow, invalid regex and type errors abort
  safely with no partial hits
- Version history per query with `undo`/`redo`
- Plan certificate: normalized AST, schema hash (SHA-256), budget and
  instruction count

## Usage

```sh
node cli.js --records fixtures/records.json --schema fixtures/schema.json \
  --query 'source:email and severity >= 3'
```

Options: `--budget <n>`, `--state <file>` (persist version history),
`--undo`, `--redo`. Exit code is 1 on any query error; output is JSON with
`hits`, `instructions` and `certificate`.

## Tests

```sh
node --test
```
