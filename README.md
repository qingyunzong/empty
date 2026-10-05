# regalloc

Minimum-cost register allocation over live intervals, in pure Go (standard
library only).

## Model

- Up to **4 registers**, up to **16 intervals**, up to 4096 program points.
- Each interval is live on `[start, end)`. It must occupy a register at its
  **definition point** (`start`) and at its **last use** (`end-1`); at every
  other point it may live in a register or in memory.
- **Calls**: a call at point `p` lists `reserved` registers that may not
  hold live values at `p`.
- **Spill costs**: moving a value from a register to memory costs
  `storeCost`; bringing it back costs `loadCost`. Register-to-register
  moves are free.
- The solver finds the **minimum total cost** allocation, or reports
  infeasibility (more must-be-in-register intervals at a point than
  available registers).

## Usage

```sh
go run ./cmd/regalloc [-brute] [input.json]   # reads stdin if no file given
```

`-brute` cross-checks the DP optimum against an exhaustive enumeration of
all register assignments (small instances only).

### Input

```json
{
  "numRegisters": 4,
  "intervals": [
    {"id": "sum", "start": 0, "end": 8, "loadCost": 3, "storeCost": 4}
  ],
  "calls": [
    {"point": 6, "reserved": [0, 1]}
  ]
}
```

### Output

- `feasible` / `cost`: optimum total spill cost.
- `occupancy`: per-point assignment of every live interval to a register
  (`reg >= 0`) or memory (`reg: -1`), plus the reserved set at call points.
- `events`: the store/load certificate; its costs sum to `cost`.
- `verified`: the certificate was re-checked against the occupancy
  (capacity, reserved registers, must-be-in-register points, cost sum).

See `examples/sample.json`.

## How it works

Because register-to-register moves are free, the cost of a solution depends
only on the *spill set* (which live intervals are in memory) at each point;
register identity only affects feasibility. The timeline is compressed to
event points (interval starts, ends, last uses, calls), and a DP over spill
sets (subsets of a 16-bit mask) finds the optimum. A concrete register
assignment is recovered greedily afterwards. `BruteForce` enumerates all
concrete register assignments independently and is used in tests to check
the DP on random small instances.

## Testing

```sh
go test ./...
```

Covers known-answer cases (forced spills, reloads, call-reserved pressure,
infeasibility), certificate verification and tamper detection, and 400
random small instances cross-checked DP vs. exhaustive enumeration.
