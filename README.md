# Deterministic Gossip Simulator

Python 3.11+ standard library only. N <= 64 nodes, fanout <= 4, rounds <= 200.

## Model

- Each node stores `store[key] = [value, origin, counter]`; a version is the
  pair `(origin, counter)`.
- Each round, every live node (in fixed node-id order) picks `fanout` peers
  and sends its digest (full key/version summary). Random peer selection uses
  a single `random.Random(seed)`; nothing else is nondeterministic and no
  wall-clock time is ever read.
- A received version that is newer (same origin, higher counter) is applied;
  a concurrent version (different origin) is resolved deterministically --
  the larger `(counter, origin)` wins -- and the loser is recorded in
  `conflicts`. Re-deliveries are idempotent no-ops.
- `converged` iff all live nodes have equal version vectors and empty
  conflict sets. This is a pure function of node state, never of real time.
- A down node does not send or receive; messages addressed to it stay
  buffered in its inbox and are delivered FIFO after `up`. `up` restores the
  node's old state; pending messages are never dropped as unsatisfiable.

## CLI

`python -m gossip` reads JSON commands, one per line, on stdin and writes one
JSON response per line. Any error prints `{"ok":false,"error":...}` and exits
with code 9.

```
{"cmd":"init","nodes":4,"seed":1,"fanout":2,"max_rounds":100,"trace":true}
{"cmd":"inject","node":0,"key":"a","value":1}
{"cmd":"down","node":2}
{"cmd":"step","rounds":10}
{"cmd":"up","node":2}
{"cmd":"step","rounds":50}
{"cmd":"status"}
```

`init` accepts `topology: "random"` (default, seeded peer sampling) or
`"ring"` (node i gossips to i+1, ...; used for the fanout=1 ring bound).
`step` replies include `status: "CONVERGED" | "NOT_CONVERGED"`; with
`trace:true` they also include the event log for the rounds just run.

## Tests

```
python -m unittest discover -s tests -v
```
