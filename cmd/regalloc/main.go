// Command regalloc reads a register-allocation problem as JSON on stdin
// (or from a file) and writes the minimum-cost allocation, the per-point
// occupancy and the store/load certificate as JSON.
//
// Usage:
//
//	regalloc [-brute] [input.json]
//
// With -brute the DP result is cross-checked against an exhaustive
// enumeration of all assignments (only practical for small instances).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"regalloc"
)

func main() {
	brute := flag.Bool("brute", false, "cross-check against exhaustive enumeration")
	flag.Parse()

	var r io.Reader = os.Stdin
	if flag.NArg() == 1 {
		f, err := os.Open(flag.Arg(0))
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		r = f
	} else if flag.NArg() > 1 {
		fatal(fmt.Errorf("at most one input file may be given"))
	}

	var in regalloc.Input
	if err := json.NewDecoder(r).Decode(&in); err != nil {
		fatal(fmt.Errorf("decoding input: %w", err))
	}
	if in.NumRegisters == 0 {
		in.NumRegisters = regalloc.MaxRegisters
	}

	out, err := regalloc.Solve(&in)
	if err != nil {
		fatal(err)
	}

	if *brute && out.Feasible {
		cost, feasible := regalloc.BruteForce(&in)
		switch {
		case !feasible:
			fatal(fmt.Errorf("DP found cost %d but brute force reports infeasible", out.Cost))
		case cost != out.Cost:
			fatal(fmt.Errorf("DP cost %d != brute-force cost %d", out.Cost, cost))
		default:
			fmt.Fprintf(os.Stderr, "brute-force cross-check OK (cost %d)\n", cost)
		}
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fatal(err)
	}
	if !out.Feasible {
		os.Exit(2)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "regalloc:", err)
	os.Exit(1)
}
