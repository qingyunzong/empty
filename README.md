# energyplan

Battery storage scheduling over at most 12 periods, minimizing total
electricity cost. Go standard library only.

## Model

- Each period has an integer `demand`, integer `price`, and integer
  `chargeLimit` / `dischargeLimit` (grid-side energy units).
- State of charge (SOC) lives on integer grid points in `[0, capacity]`;
  `initial` and `final` SOC are fixed boundary conditions.
- Efficiencies are positive rationals (`"0.9"`, `"9/10"`, `"1"`). An action
  is legal only when the stored-energy delta lands exactly on the grid:
  charging `g` grid units stores `g*eff`, discharging `h` grid units consumes
  `h/eff` stored units.
- Charging and discharging never happen in the same period.
- Net grid purchase per period (`demand + charge - discharge`) must be
  non-negative: the battery serves demand, it does not sell back.
- Cost per period is `price * net`; the solver minimizes the total.

## Usage

```sh
go run . -input example.json          # print the per-period energy certificate
go run . -input example.json -verify  # also cross-check by exhaustive enumeration
cat example.json | go run .           # specs may also come from stdin
```

The certificate lists, per period: demand, price, action
(idle/charge/discharge), grid energy charged/discharged, net purchase, the
SOC transition, and the period cost, followed by the total cost.

`-verify` re-solves the instance by enumerating every action sequence
(exponential; intended for small instances) and fails if it disagrees with
the dynamic-programming optimum.

## Solver

`Solve` runs a shortest-path DP over the integer SOC grid (states
`0..capacity`, 12 periods), and `BruteForce` enumerates all action sequences
as an independent correctness oracle. `TestDPvsBruteForceRandom` compares
them on 300 seeded random small instances.

## Tests

```sh
go test ./...
```
