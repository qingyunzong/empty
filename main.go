package main

import (
	"flag"
	"fmt"

	"simreplay/sim"
)

func main() {
	seed := flag.Uint64("seed", 1, "deterministic RNG seed")
	nodes := flag.Int("nodes", 5, "number of simulated nodes")
	steps := flag.Int("events", 1000, "number of events to replay")
	flag.Parse()

	res := sim.Check(*seed, *nodes, *steps)
	if res.Consistent {
		fmt.Printf("consistent: seed=%d nodes=%d events=%d — resuming from every snapshot matches the full replay byte-for-byte\n", *seed, *nodes, res.Steps)
	} else {
		fmt.Printf("divergence: first inconsistent event at index %d of %d (seed=%d nodes=%d)\n", res.DivergeAt, res.Steps, *seed, *nodes)
	}
}
