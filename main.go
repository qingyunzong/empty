// Command trainsim runs a train simulation over mutually exclusive
// sections and prints each train's trajectory, the refusal evidence for
// rejected reservation requests, and a snapshot/recovery consistency
// check.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"trainsim/sim"
)

const (
	numSections = 10
	totalTicks  = 14
	snapTick    = 7
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	s := sim.New(numSections)
	for _, spec := range []struct {
		id    string
		pos   int
		brake int
	}{
		{"T1", 0, 2},
		{"T2", 2, 2},
		{"T3", 5, 2},
	} {
		if err := s.AddTrain(spec.id, spec.pos, spec.brake); err != nil {
			return err
		}
	}
	// T2 breaks down at tick 4 and never releases its section.
	s.ScheduleFault(4, "T2")

	var snap *sim.Snapshot
	for i := 0; i < totalTicks; i++ {
		s.Step()
		if err := s.Verify(); err != nil {
			return fmt.Errorf("tick %d: %w", s.Tick, err)
		}
		if s.Tick == snapTick {
			snap = s.Snapshot()
		}
	}

	fmt.Printf("== Trajectories (%d sections, %d ticks) ==\n", numSections, totalTicks)
	for _, t := range s.Trains() {
		status := "waiting"
		switch {
		case t.Faulty:
			status = "FAULTY (holds section)"
		case t.Arrived:
			status = "arrived"
		}
		fmt.Printf("train %s brake=%d final=%s\n", t.ID, t.Brake, status)
		for _, p := range t.Traj {
			fmt.Printf("  tick %2d -> section %d\n", p.Tick, p.Pos)
		}
	}

	fmt.Println("\n== Refusal evidence (rejected reservations) ==")
	rejects := s.Rejections()
	if len(rejects) == 0 {
		fmt.Println("  none")
	}
	for _, e := range rejects {
		fmt.Printf("  tick %2d train %s needs sections %v rejected:\n", e.Tick, e.Train, e.Sections)
		for _, b := range e.Blockers {
			switch {
			case b.Occupant != "":
				fmt.Printf("    section %d occupied by %s\n", b.Section, b.Occupant)
			default:
				fmt.Printf("    section %d reserved by %s\n", b.Section, b.ReservedBy)
			}
		}
	}

	fmt.Printf("\n== Snapshot / recovery check (snapshot at tick %d) ==\n", snapTick)
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	var restored sim.Snapshot
	if err := json.Unmarshal(data, &restored); err != nil {
		return err
	}
	rec, err := sim.Recover(&restored, s.Events)
	if err != nil {
		return err
	}
	if fmt.Sprint(rec.State()) != fmt.Sprint(s.State()) {
		return fmt.Errorf("recovered state diverges from original")
	}
	fmt.Printf("  replayed %d events, invariants hold: no duplicate section occupancy\n",
		len(s.Events)-countEventsUpTo(s.Events, snapTick))
	fmt.Println("  recovered state matches original state")
	return nil
}

func countEventsUpTo(events []sim.Event, tick int) int {
	n := 0
	for _, e := range events {
		if e.Tick <= tick {
			n++
		}
	}
	return n
}
