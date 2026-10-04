# trafficsim

Deterministic tick-based traffic simulation in pure Go standard library.

## Model

- Vehicles follow routes of capacity-limited segments (`sim.go`).
- A vehicle's **tail** keeps occupying the previous segment until its front
  has advanced one vehicle length into the next (`vehicleOccupies`).
- Intersections expose a **public mutual-exclusion conflict table**
  (`Intersection.Conflicts`); conflicting movements are never granted in
  the same tick.
- Each tick runs **release → move → grant**: finished vehicles free their
  capacity first, then pending requests are granted per intersection ordered
  by **waiting time (longest first), ties broken by vehicle ID (smallest
  first)**.
- `Sim.Snapshot()` deep-copies the state; resuming a snapshot yields an
  identical trajectory (all iteration order is deterministic).
- `Sim.WaitForGraph()` / `Sim.FindDeadlockCycle()` build the capacity
  wait-for graph and return a vehicle-ID cycle as deadlock evidence.

## Test results

`go test ./...` (go1.27.1, GOCACHE=/tmp/gocache):

```
ok  	trafficsim	0.007s
```

Coverage: release-before-grant ordering, grant priority (wait then ID),
tail occupancy, vehicle conservation, no-collision + capacity invariants
(with evidence the conflict table actually blocks), snapshot trajectory
consistency, and 4-vehicle gridlock cycle evidence.
