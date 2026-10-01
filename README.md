# lpsynth

Linearization-point interval synthesis for concurrent histories. Given a
history of calls/returns on a concurrent object, `lpsynth` computes, for
every completed operation, the feasible interval for its linearization
point (LP) — not just a boolean linearizability verdict.

Pure Python 3.11+ standard library; tests use `unittest`.

## Usage

```
python -m lpsynth solve history.json --type stack --timeout-ms 2000
```

Output is JSON on stdout:

```json
{
  "status": "OK",
  "intervals": {"p1": [0, 2], "p2": [1, 8], "po": [5, 8]},
  "conflict": []
}
```

## Input format

```json
{
  "type": "stack",
  "operations": [
    {"id": "p1", "op": "push", "value": 1, "start": 0, "end": 2},
    {"id": "po", "op": "pop",  "value": 1, "start": 3, "end": 5},
    {"id": "pp", "op": "push", "value": 2, "start": 1, "end": null}
  ]
}
```

- `start`/`end` are the call/return times; the LP must lie in `[start, end]`.
- `end: null` (or omitted) means the operation is **pending**.
- A completed `pop` must carry its observed return in `value`; the reserved
  string `"EMPTY"` denotes a pop on an empty stack.
- A pending `pop` may omit `value` (unknown return).

## Semantics

1. Every operation's LP lies within its `[start, end]` window.
2. Real-time order (`end_i <= start_j` forces `i` before `j`) and stack
   semantics (LIFO; `"EMPTY"` pops only on an empty stack) constrain the
   valid LP orders. Feasible intervals are the projection of the LP feasible
   region over all valid orders, intersected with each op's own window.
3. `INFEASIBLE`: completed operations cannot be linearized regardless of
   what pending operations do. `conflict` holds a greedily minimized set of
   operation ids that is already infeasible on its own.
4. `UNKNOWN`: completed operations alone are infeasible, but some assumption
   about pending operations (a pending push having taken effect, a pending
   pop having removed an element) makes the history linearizable. Pending
   operations only extend the unknown; they never turn a feasible completed
   prefix into a failure.
5. `TIMEOUT`: the time budget expired. `intervals` contains the bounds
   tightened as far as was proven before the deadline (real-time constraint
   propagation plus any fully explored orders).

## Statuses and exit codes

| status       | meaning                                   | exit code |
|--------------|-------------------------------------------|-----------|
| `OK`         | completed ops linearizable; exact intervals | 0         |
| `INFEASIBLE` | no valid linearization, pending-independent | 1         |
| `UNKNOWN`    | feasibility depends on pending operations | 3         |
| `TIMEOUT`    | budget exceeded; partially tightened intervals | 6      |
| —            | invalid input (bad JSON/schema/type)      | 2         |

## Algorithm

- Interval constraint propagation over real-time precedence edges
  (`t_i <= t_j` tightens `lo_j`/`hi_i` to a fixpoint).
- Backtracking enumeration of linearization orders consistent with
  precedence, LP windows, and LIFO semantics; per-order feasible bounds via
  forward/backward passes, merged across orders.
- UNKNOWN check re-runs the search allowing pending pushes/pops to be
  interleaved; conflict sets are greedily minimized infeasible subsets.
- The deadline is checked periodically during the search; expiry yields
  `TIMEOUT` with the intervals proven so far.

## Tests

```
python -m unittest discover -s tests -v
```
