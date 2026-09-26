// Command netsim runs three discrete-event scenarios (pause, drop, delay)
// over the same release/fault schedule and prints the final state of every
// packet. It simulates integer ticks only; no network is used.
package main

import (
	"fmt"

	"netsim"
)

func main() {
	run("pause", netsim.PolicyPause, 0)
	run("drop", netsim.PolicyDrop, 0)
	run("delay(+2)", netsim.PolicyDelay, 2)
}

func run(label string, policy netsim.Policy, delay int) {
	// latency 3, one packet per tick:
	//   p1 released tick 0, p2 released tick 1,
	//   fault starts tick 2 (policy fixed here), p3 released tick 3,
	//   link recovers tick 6.
	s := netsim.NewSim(&netsim.Link{Name: "L", Latency: 3, Rate: 1})
	s.Release(0, 1, 100)
	s.Release(1, 2, 100)
	s.Fault(2, policy, delay)
	s.Fault(3, policy, delay) // duplicate: idempotent, ignored
	s.Release(3, 3, 100)
	s.Recover(6)
	end := s.Run()

	fmt.Printf("scenario: fault=%s  end tick=%d\n", label, end)
	for _, p := range s.Packets() {
		switch p.State {
		case netsim.StateDelivered:
			fmt.Printf("  pkt %d: %-10s sent@%d delivered@%d\n", p.ID, p.State, p.SentAt, p.FinishAt)
		case netsim.StateDropped:
			fmt.Printf("  pkt %d: %-10s sent@%d dropped@%d (stays dropped after recovery)\n", p.ID, p.State, p.SentAt, p.FinishAt)
		default:
			fmt.Printf("  pkt %d: %-10s enqueued@%d sent@%d\n", p.ID, p.State, p.EnqueuedAt, p.SentAt)
		}
	}
	fmt.Println()
}
