# effectcheck

Effect inference over a function call graph. For every function the
checker derives its externally observable effect set — regions read,
regions written, exceptions thrown — and reports diagnostics with source
paths (`file:line:col`).

## Language

```
global db, log            // global regions

fn fetch(q):              // parameters are region-typed
    region tmp            // function-local region (effects are masked)
    read db
    call record(q)        // callee effects are substituted into the caller
    throw IOError
    return q
```

## Analysis

- Effects propagate along call edges with parameter-to-argument
  substitution; effects on function-local regions are masked.
- Recursive and mutually recursive functions are solved by least fixed
  point iteration over the call graph's strongly connected components.
- A local region returned from a function is an escape error, reported
  with its source path.
- `Incremental.ReplaceFunc` re-analyzes only the dirty portion of the
  call graph after a body edit; results match a full re-analysis.

## Usage

```
go test ./...
go run ./cmd/effectcheck examples/demo.fx
```
