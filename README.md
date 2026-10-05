# firesim

Finite-grid fire propagation library in pure Go (standard library only).

## Public integer rules

The grid is finite (`Width` x `Height`), cells are `Empty`, `Tree`,
`Burning` or `Burnt`, and every round all cells update simultaneously
from the previous round's state. All probabilities are integers per
1024; no floating point is used anywhere.

- `Burning` -> `Burnt`; `Burnt` and `Empty` are stable.
- A `Tree` ignites when, for any burning von Neumann neighbour in
  direction `d` (probed in the fixed order N, E, S, W),
  `rng.next() & 1023 < t` with `t = BaseProb`, plus `WindBoost` when the
  neighbour lies upwind (wind pushes fire downwind).
- Wind is piecewise constant: the `WindSegment` with the latest
  `FromRound <= round` wins.
- Extinguish `Event`s scheduled for round `r` run at the start of round
  `r`, before that round's propagation: the cell reverts to `Tree`
  and does not ignite its neighbours that round.

## Reproducibility and continuation

- The PRNG is splitmix64; its 64-bit state and the original seed are
  recorded in every checkpoint (`Checkpoint`, `SaveCheckpoint`,
  `LoadCheckpoint`, JSON on disk).
- `Run(budget, checkpointPath)` advances at most `budget` rounds; when
  the budget is exhausted before the fire dies out, it saves a
  continuation point. Resuming from it reproduces the uninterrupted run
  cell for cell (verified by `TestSegmentedRunMatchesSingleRun` and
  `TestCheckpointRoundTripContinuesIdentically`).

## Test results

`go test ./...` (go1.27.1 linux/amd64), actual output:

```
ok  	firesim	0.012s
```

All 9 tests pass: simultaneous update, extinguish-before-propagation
(2x), wind segments, wind schedule lookup, seed determinism, checkpoint
seed/state recording, budget-exhaustion checkpointing, segmented-run
equivalence, checkpoint round-trip equivalence.
