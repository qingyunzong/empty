# lpsynth

Linearization-point **interval synthesis** for concurrent stack histories.
Instead of a boolean linearizability verdict, `lpsynth` reports, for every
completed operation, the feasible interval (intersection over all valid
linearizations) in which its linearization point can fall.

## Usage

```
python -m lpsynth solve history.json --type stack --timeout-ms 2000
```

Output (JSON on stdout):

```json
{
  "status": "OK",
  "intervals": {"p1": [0, 10], "p2": [1, 2], "p3": [2, 8]},
  "conflict": null
}
```

### Status semantics

- `OK` — completed operations are linearizable; `intervals` maps each
  completed operation id to `[lo, hi]`, the tightest time range in which its
  linearization point can be placed in some valid linearization.
- `INFEASIBLE` — completed operations cannot be linearized regardless of any
  pending operations; `conflict` is a minimal infeasible subset (unsat core)
  of operation ids.
- `UNKNOWN` — the completed sub-history is infeasible on its own, but a
  pending operation (called, not yet returned) could explain it. Pending
  operations only extend the unknown; they never turn a verdict into
  `INFEASIBLE`.
- `TIMEOUT` — the time budget was exceeded; `intervals` contains the
  intervals tightened so far by constraint propagation.

### Exit codes

- `0` — `OK`, `INFEASIBLE` or `UNKNOWN`
- `2` — invalid input (malformed JSON, schema violation, bad flags)
- `6` — `TIMEOUT`

## Input format

```json
{
  "type": "stack",
  "operations": [
    {"id": "p1", "op": "push", "arg": 1, "call": 0, "return": 10},
    {"id": "p2", "op": "push", "arg": 2, "call": 1, "return": 9},
    {"id": "p3", "op": "pop", "call": 2, "return": 8, "result": 2},
    {"id": "p4", "op": "push", "arg": 3, "call": 4}
  ]
}
```

- `call` / `return` are event times (numbers); an operation's linearization
  point must lie inside `[call, return]`.
- An operation without `return` (or `"return": null`) is **pending**.
- A completed `pop` requires `result`: the returned value, or the string
  `"EMPTY"` for a pop on an empty stack.
- `push` requires `arg`.

## Semantics

1. Every linearization point lies within its operation's `[call, return]`.
2. Return values induce a precedence order; stack `push`/`pop` match in LIFO
   order, and a pop on an empty stack returns `EMPTY`.
3. A completed history with no feasible linearization, independent of pending
   operations, is `INFEASIBLE` and reports a conflicting operation set.
4. Pending operations can only extend the unknown: if feasibility depends on
   assumptions about pending operations, the verdict is `UNKNOWN`.
5. On timeout the verdict is `TIMEOUT` with the intervals tightened so far.

## Method

Event times are discretized into candidate slots. Domains (slots per
operation) are tightened by all-different interval constraint propagation
(singleton elimination + Hall-interval pruning). A backtracking search then
enumerates linearization orders consistent with real-time precedence and
stack semantics; for each order, earliest/latest greedy slot assignments
yield per-operation feasible ranges, unioned across all orders. Feasibility
checks are memoized on (linearized set, stack, last slot). A deadline is
checked periodically; exceeding it yields `TIMEOUT`.

## Tests

```
python -m unittest discover -s tests -v
```

Covers: (A) two-push/one-pop intervals vs. a hand-computed reference,
(B) wrong pop order -> `INFEASIBLE`, (C) missing return (pending) ->
`UNKNOWN`, (D) `--timeout-ms 0` -> `TIMEOUT`, plus validation and CLI
exit-code tests. See `TEST_RESULTS.txt` for the recorded run.
