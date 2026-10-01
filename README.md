# Deterministic Gossip Simulator

A deterministic gossip protocol simulator. Same seed ⇒ byte-identical event
trace. No wall-clock or other non-deterministic input is ever used.

## Model

- `N <= 64` nodes, `fanout <= 4`, at most 200 rounds (`MAX_ROUNDS`).
- Each node stores `key -> [version, origin, value]`.
- Each round every live node picks `fanout` peers in a fixed, seed-derived
  order and sends its digest; messages are delivered in the same round.
- Receive semantics: strictly higher version is applied; equal version with
  different origin/value becomes a conflict; identical/lower versions are
  ignored, so duplicates are idempotent. A higher version clears conflicts.
- A down node neither sends nor receives; messages addressed to it stay
  buffered in its FIFO inbox and are delivered in order after `up`.
  `up` restores the node's old state; pending messages are never dropped.
- Converged iff all live nodes have equal version vectors and no live node
  has conflicts. After 200 rounds without convergence, status reports
  `NOT_CONVERGED`.

## CLI

`python3 -m gossip` reads JSON commands, one per line, from stdin and writes
JSON event/response lines to stdout. Any error prints
`{"ok":false,"error":...}` and exits with status 9.

```json
{"cmd":"init","nodes":8,"seed":42,"fanout":2,"topology":"random"}
{"cmd":"inject","node":0,"key":"k","value":1}
{"cmd":"down","node":3}
{"cmd":"up","node":3}
{"cmd":"step","rounds":10}
{"cmd":"status"}
```

`topology` is `"random"` (default, seed-derived peer sampling) or `"ring"`
(requires `fanout=1`, node `i` gossips to `(i+1) % N`; a single key then
converges within the theoretical bound of `N-1` rounds).

## Tests

```
python3 -m unittest discover -s tests -v
```

Covers: (A) byte-identical traces for identical seeds, (B) <=8 nodes with
random failures vs. a full-sync reference, (C) fanout=1 ring convergence
within the theoretical bound / `NOT_CONVERGED`, (D) buffering during
downtime with in-order, lossless delivery after recovery, plus conflict,
idempotency and CLI error (exit 9) semantics.
