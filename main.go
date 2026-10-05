package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	input := flag.String("input", "", "path to JSON spec (default: read from stdin)")
	verify := flag.Bool("verify", false, "cross-check the DP optimum by exhaustive action enumeration (small instances)")
	flag.Parse()

	var r io.Reader = os.Stdin
	if *input != "" {
		f, err := os.Open(*input)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		defer f.Close()
		r = f
	}

	spec, err := DecodeSpec(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	plan, err := Solve(spec)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	fmt.Print(RenderCertificate(plan, spec))

	if *verify {
		best, feasible, err := BruteForce(spec)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		if !feasible || best != plan.TotalCost {
			fmt.Fprintf(os.Stderr, "verify FAILED: dp=%d brute-force=(cost %d, feasible %v)\n",
				plan.TotalCost, best, feasible)
			os.Exit(1)
		}
		fmt.Printf("verify: exhaustive enumeration agrees, optimum = %d\n", best)
	}
}
