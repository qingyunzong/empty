# protocheck

CLI for testing an implementation against a finite protocol state table,
using only the Go standard library.

Given a state table and an implementation adapter, it:

- generates legal action histories of up to `n` steps (BFS, shortest first);
- locates a goal state by its shortest history and returns that history,
  or the observed state difference when the implementation diverges;
- checks illegal actions separately: each must return an error and must
  not change the state;
- records every real adapter call and its real output in the report;
- never writes `PASS` when the exploration budget did not close
  (verdict `INCONCLUSIVE` instead).

## State table

JSON, deterministic (see `examples/door.json`):

```json
{
  "initial": "closed",
  "states": ["closed", "open", "locked"],
  "transitions": [
    {"action": "open", "from": "closed", "to": "open"}
  ]
}
```

## Usage

```sh
go build ./cmd/protocheck ./cmd/demoimpl

# list generated legal histories up to n steps
protocheck -table examples/door.json -list -n 2

# check against the built-in simulator, locate goal state "locked"
protocheck -table examples/door.json -goal locked -n 3 -adapter sim

# check an external implementation speaking JSON lines over stdin/stdout
protocheck -table examples/door.json -goal open -n 2 -adapter exec \
  -cmd "demoimpl -table examples/door.json"
```

Flags: `-goal`, `-n` (step budget, default 5), `-adapter sim|exec`,
`-cmd`, `-no-illegal`, `-list`, `-report <file>`.

## Adapter protocol (exec)

Requests (one JSON object per line on stdin):

- `{"op":"reset"}`
- `{"op":"apply","action":"open"}`
- `{"op":"state"}`

Responses: `{"ok":true}` or `{"error":"..."}`; `state` replies
`{"ok":true,"state":"open"}`. `cmd/demoimpl` is a reference server.

## Verdicts

- `PASS` (exit 0): budget closed, goal located (if given), no state
  differences, all illegal actions rejected without state change.
- `FAIL` (exit 1): state difference, rejected legal action, accepted or
  state-changing illegal action, or goal unreachable after closed
  exploration.
- `INCONCLUSIVE` (exit 2): budget of `n` steps exhausted before
  exploration closed. Never reported as PASS.

## Tests

```sh
go test ./...
```
