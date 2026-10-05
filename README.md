# tollroute

Minimum-toll routing CLI over a finite state graph, Go standard library only.

## Model

- Up to **10 nodes**, integer fuel with capacity at most **20**, up to **6**
  one-time discount coupons, integer time with horizon at most **60**.
- State = `(node, fuel, couponMask, time)`. Every action strictly increases
  time, so the state graph is a finite DAG.
- Actions:
  - **drive** an edge: pays `toll`, consumes integer `fuel`, takes `time`;
    allowed only if a departure `t' >= t` falls inside one of the edge's
    open **time windows** (waiting for a window is implicit).
  - **discount**: same drive, but spends coupon `i` once
    (`pay = max(0, toll - value_i)`); the coupon bit is set in the mask, so
    the same coupon can never be reused — including on a return trip.
  - **refuel** at a supply station: refills to full for `fee`, takes
    `duration`; requires a free charging slot at the start time
    (`occupancy[t] < capacity`).
  - **wait** one time unit at the current node.
- All tolls, fees and coupon values are non-negative; validated on load.

## Search

- A* over the state graph. The heuristic is the shortest-path distance on a
  relaxed graph (fuel, windows, capacity and coupon availability ignored),
  which is an admissible **lower bound** on the remaining toll. While paused,
  the minimum frontier `f`-value is a valid lower bound on the optimum.
- The optimal **certificate** (full transition sequence) is printed and can
  be replayed/validated step by step (`Scenario.Replay`).
- **Pause/resume**: `-max-pops N` or the `-deadline` budget pauses the
  search and saves the complete frontier (priority queue + best-cost map +
  parents) as JSON; `-resume` continues exactly.
- **Independent cross-check**: `BruteForce` is a separate depth-first
  exhaustive enumeration of the same finite state graph (no priority queue,
  no heuristic). `-verify` runs it and compares optima; the test suite
  compares both engines on hundreds of tiny random instances.

## Usage

```sh
go run . -scenario scenario.json            # solve, print certificate + lower bound
go run . -scenario scenario.json -verify    # also cross-check exhaustively
go run . -demo                              # built-in demo scenario
go run . -scenario scenario.json -max-pops 20 -save frontier.json   # pause
go run . -scenario scenario.json -resume frontier.json              # resume
go test ./...                               # full test suite
```

## Scenario format

See `scenario.json`. Key fields: `nodes`, `start`, `goal`, `fuelCap`,
`startFuel`, `horizon`, `discounts` (coupon values), `edges` (`from`, `to`,
`fuel`, `time`, `toll`, optional `windows`, `discount` id or -1), and
`stations` (`node`, `fee`, `duration`, `capacity`, `occupancy` per time slot).
