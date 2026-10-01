# lincheck

Linearizability checker for concurrent histories (register and queue),
pure Python 3.11 standard library.

## Usage

```
python -m lincheck verify history.json --impl register|queue --max-states 100000
```

## History format

Either a bare list of operations, or an object with `operations`
(or `events`) and an optional `initial` value:

```json
{
  "initial": 0,
  "operations": [
    {"id": 0, "thread": 0, "op": "write", "arg": 1, "start": 0, "end": 2},
    {"id": 1, "thread": 1, "op": "read", "ret": 1, "start": 3, "end": 4},
    {"id": 2, "thread": 2, "op": "write", "arg": 2, "start": 5}
  ]
}
```

An operation without `end` is **pending** (no return observed). The
`events` form pairs `call`/`return` events by `(thread, id)`; a call
without a matching return is pending.

Register ops: `read`/`write`. Queue ops: `enqueue`/`dequeue`
(empty dequeue is `ret: null`).

## Verdicts and exit codes

| Verdict             | Meaning                                              | Exit |
|---------------------|------------------------------------------------------|------|
| `LINEARIZABLE`      | legal order found; a linearization point sequence is printed | 0 |
| `NON_LINEARIZABLE`  | all permutations fail; a minimal conflicting prefix is printed | 1 |
| `UNKNOWN`           | undecidable only because of pending operations       | 5 |
| `UNKNOWN_RESOURCE`  | `--max-states` budget exhausted                      | 5 |
| invalid input       | malformed JSON / history / arguments                 | 2 |

## Algorithm

Backtracking search over linearization orders constrained by real-time
order (non-overlapping intervals keep their order). Pruning:

- only operations whose real-time predecessors are all placed are eligible;
- completed operations prune immediately on a return-value mismatch;
- visited `(remaining-set, object-state)` pairs are memoized.

Pending operations may take any legal transition (any legal return).
If no linearization exists and the history contains pending operations,
the verdict is `UNKNOWN` rather than a failure.

## Tests

```
python -m unittest discover -s tests -v
```
