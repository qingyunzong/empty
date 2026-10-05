# taintcli

A taint-analysis CLI over a limited control-flow graph (Go standard library only).

- Taint propagates along **data dependencies** (assignments) and **conditional
  branches** (implicit flow: a tainted condition taints everything assigned
  under it).
- **Sanitizers are context-specific**: `sanitize` only clears the contexts it
  declares; a value cleaned for `html` still leaks into a `sql` sink.
- **Loops** are handled by least fixed-point iteration over a finite lattice
  (variables x context universe), so termination is guaranteed.
- Every leak is reported together with each concrete **leak path**, found by
  bounded expansion of the graph (each node visited at most `-unroll` times).

## Input format (JSON)

```json
{
  "entry": "n1",
  "nodes": [
    {"id": "n1", "kind": "source",   "var": "u", "next": "n2"},
    {"id": "n2", "kind": "assign",   "var": "q", "uses": ["u"], "next": "n3"},
    {"id": "n3", "kind": "sanitize", "var": "s", "arg": "q", "contexts": ["html"], "next": "n4"},
    {"id": "n4", "kind": "sink",     "args": ["s"], "context": "sql"},
    {"id": "n5", "kind": "branch",   "uses": ["u"], "then": "n6", "else": "n7"}
  ]
}
```

Node kinds: `source` (taints `var` in all contexts), `assign` (`var` =
f(`uses`)), `sanitize` (`var` = cleaned `arg` for `contexts` only), `sink`
(sensitive call consuming `args` in `context`), `branch` (condition reads
`uses`, successors `then`/`else`). All other nodes use `next`.

## Usage

```
go run ./cmd/taint [-unroll N] program.json   # or pipe JSON via stdin
```

Exit code is 1 when any leak is found, 0 otherwise. Examples live in
`examples/`: `leak.json` (wrong-context sanitizer), `safe.json`,
`loop.json` (taint around a back edge).

## Tests

```
go test ./...
```
