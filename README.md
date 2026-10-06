# regalloc

Exact minimum-cost register allocation CLI (Go standard library only).

- Up to **4 registers**, up to **16 live intervals** over integer program points.
- Call sites may **reserve registers** at a point; reserved registers hold nothing there.
- Spilling costs: per-interval `storeCost` / `loadCost`.
- Output: per-point occupancy + spill load/store certificate; a built-in
  verifier replays the certificate, and `-check` cross-validates the
  optimum by exhaustive enumeration of all allocations.

## Cost model

Register-symmetric, move-free:

- interval starts spilled -> `storeCost` (definition stored to memory);
- register -> spilled transition -> `storeCost`; spilled -> register -> `loadCost`;
- interval death is free.

## Usage

```sh
go build -o regalloc .
./regalloc -i example.json            # text: occupancy + events
./regalloc -i example.json -f json    # JSON certificate
./regalloc -i example.json -f events  # load/store events only
./regalloc -i example.json -check     # exhaustive cross-check of optimum
cat example.json | ./regalloc         # reads stdin by default
```

## Input format

```json
{
  "registers": ["r0", "r1", "r2", "r3"],
  "intervals": [{"name": "a", "start": 0, "end": 6, "loadCost": 2, "storeCost": 2}],
  "calls": [{"point": 3, "reserved": ["r2", "r3"]}]
}
```

## Method

DP over program points; the state is the subset of live intervals resident
in registers (|subset| <= available registers at that point). Transition
costs decompose per interval. Concrete register names are assigned
afterwards, preferring to keep an interval in its previous register.
`Verify` independently replays the certificate (legality of occupancy,
reserved sets, event stream, total cost). Tests compare the DP optimum
against exhaustive enumeration on 500 seeded random small instances.

## Test

```sh
go test ./...
```
