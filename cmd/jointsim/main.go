package main

import (
	"fmt"
	"os"

	"jointsim"
)

func main() {
	initial := []string{"A", "B", "C"}
	sim := jointsim.NewSim(initial, "A", nil)
	sim.Propose("set x=1")
	sim.Run()
	if err := sim.ChangeMembership([]string{"A", "D", "E"}); err != nil {
		fmt.Fprintln(os.Stderr, "change membership:", err)
		os.Exit(1)
	}
	sim.Propose("set y=2")
	sim.Run()

	fmt.Println("commit quorum certificates:")
	for _, c := range jointsim.Certificates(sim.Trace) {
		fmt.Println(" ", c)
	}
	if err := jointsim.CheckTrace(sim.Trace, initial); err != nil {
		fmt.Fprintln(os.Stderr, "trace check failed:", err)
		os.Exit(1)
	}
	fmt.Println("trace check: OK")
}
