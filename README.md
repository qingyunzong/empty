# effectcheck

Effect-set inference over a function call graph: reads/writes of abstract
regions and raised exceptions, each recorded with its source path.

- Recursive and mutually recursive calls are resolved by iterating the
  summary equations to their least fixed point.
- Regions local to a function are hidden from its callers and must not
  escape via `return` (reported as diagnostics).
- `Analyzer` supports incremental updates: after editing a function body,
  only the function and its transitive callers are recomputed, and the
  result is identical to a full re-analysis.

## Test

```sh
go test ./...
```

## CLI

```sh
go run ./cmd/effectcheck program.json
```

Input JSON:

```json
{"functions": [
  {"name": "main", "locals": ["buf"], "body": [
    {"op": "read",   "region": "in",  "path": "src/main.ef:3"},
    {"op": "call",   "target": "put", "path": "src/main.ef:5"},
    {"op": "return", "region": "out", "path": "src/main.ef:7"}
  ]}
]}
```

`op` is one of `read`, `write`, `call`, `throw`, `return`. The tool prints
per-function effect sets with source paths and exits non-zero if any
diagnostic (e.g. a local region escaping via return) is reported.
