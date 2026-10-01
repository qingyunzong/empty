# lincheck

A small linearizability checker for concurrent histories (Python 3.11+
standard library only).

## Usage

```
python -m lincheck verify history.json --impl register|queue --max-states 100000
```

## History format

A JSON list of operation records:

```json
[
  {"id": 1, "thread": "A", "op": "write", "arg": 1, "ret": null, "start": 0, "end": 10},
  {"id": 2, "thread": "C", "op": "read",  "arg": null, "ret": 1, "start": 2, "end": 3}
]
```

- `end: null` (or missing) marks a **pending** call: invoked, no response observed.
- Overlapping `[start, end]` intervals may be reordered; `end_i <= start_j`
  forces `i` before `j`.
- Alternatively, call/return events matched by `(thread, id)` are accepted:
  `{"type": "call"|"return", "id": ..., "thread": ..., "time": ...}`.
- Top-level object form `{"events": [...], "initial": V}` sets the model's
  initial state.

Supported operations:

- **register**: `read`/`get`, `write`/`put`/`set` (write returns `null`/`"ok"`)
- **queue**: `enq`/`enqueue`/`offer`/`push`, `deq`/`dequeue`/`poll`/`pop`
  (deq on empty returns `null`/`"empty"`)

## Verdicts and exit codes

| Verdict             | Meaning                                              | Exit |
|---------------------|------------------------------------------------------|------|
| `LINEARIZABLE`      | legal order exists; one linearization is printed     | 0    |
| `NON_LINEARIZABLE`  | all orders fail, even assuming pending responses; a minimal conflicting prefix is printed | 1 |
| `UNKNOWN`           | linearizable only by assuming responses for pending calls | 5 |
| `UNKNOWN_RESOURCE`  | `--max-states` budget exhausted (never reported as FAIL) | 5 |
| invalid input       | malformed JSON/history                               | 2    |

## How it works

Backtracking search over linearizations, pruned by memoising
`(placed-set, object-state)` pairs. Phase 1 checks completed operations
only (pending calls may be dropped). Phase 2 additionally lets pending
calls take effect with any legal response; success there downgrades the
verdict to `UNKNOWN` rather than `FAIL`.

## Tests

```
python -m unittest discover -s tests -v
```
