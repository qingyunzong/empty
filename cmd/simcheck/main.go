// Command simcheck replays a seeded event log and verifies that jumping to
// any event via a snapshot and continuing matches the full replay
// byte-for-byte. It prints the minimal inconsistent event position, or
// reports that the run is consistent.
package main

import (
	"flag"
	"fmt"

	"simcheck/sim"
)

func main() {
	seed := flag.Uint64("seed", 1, "random seed fixing all randomness")
	nodes := flag.Int("nodes", 4, "number of simulated nodes")
	n := flag.Int("events", 200, "number of events to replay")
	flag.Parse()

	cfg := sim.Config{NumNodes: *nodes, Seed: *seed}
	events := sim.Generate(cfg, *n)

	idx := sim.FindMinimalDivergence(cfg, events, (*sim.Sim).Snapshot)
	if idx == -1 {
		fmt.Printf("consistent: all %d jump points match the full replay byte-for-byte (seed=%d nodes=%d events=%d)\n",
			len(events)+1, *seed, *nodes, *n)
		return
	}
	fmt.Printf("minimal inconsistent event position: %d (%v)\n", idx, events[idx])
}
