// Command trainsim runs a demo depot scenario, prints the full trajectory and
// rejection evidence, then snapshots, recovers from the event log, and
// verifies there is no duplicate section occupancy.
package main

import (
	"fmt"
	"os"

	"trainsim"
)

func main() {
	t1 := trainsim.NewTrain(1, []int{1, 2, 3, 4, 5, 6, 7, 8}, 2)
	t2 := trainsim.NewTrain(2, []int{2, 3, 4, 5, 6, 7, 8, 9}, 2)
	t3 := trainsim.NewTrain(3, []int{5, 6, 7, 8, 9, 10}, 1)
	t3.FaultAt = 4 // faults while underway and never releases its section

	sim := trainsim.NewSim(t1, t2, t3)
	sim.Run(30)

	fmt.Println("=== trajectory ===")
	for _, e := range sim.Events {
		fmt.Println(e)
	}

	fmt.Println("=== rejection evidence ===")
	rejections := 0
	for _, e := range sim.Events {
		if e.Type == trainsim.EventReject {
			rejections++
			fmt.Println(e.Evidence.Reason)
		}
	}
	if rejections == 0 {
		fmt.Println("(none)")
	}

	snap := sim.Snapshot()
	fmt.Printf("=== snapshot @tick %d ===\noccupancy: %v\nreservations: %v\n",
		snap.Tick, snap.Occupancy, snap.Reservations)

	data, err := trainsim.MarshalEvents(sim.Events)
	if err != nil {
		fmt.Fprintln(os.Stderr, "marshal:", err)
		os.Exit(1)
	}
	loaded, err := trainsim.UnmarshalEvents(data)
	if err != nil {
		fmt.Fprintln(os.Stderr, "unmarshal:", err)
		os.Exit(1)
	}
	recovered, err := trainsim.Recover(loaded)
	if err != nil {
		fmt.Fprintln(os.Stderr, "recovery verification failed:", err)
		os.Exit(1)
	}
	fmt.Printf("=== recovered occupancy @tick %d ===\n%v\n", recovered.Tick, recovered.Occupancy)

	match := len(recovered.Occupancy) == len(snap.Occupancy)
	for sec, id := range snap.Occupancy {
		if recovered.Occupancy[sec] != id {
			match = false
		}
	}
	if !match {
		fmt.Fprintln(os.Stderr, "recovered occupancy does not match live snapshot")
		os.Exit(1)
	}
	fmt.Println("recovery check OK: no duplicate section occupancy, occupancy matches snapshot")
}
