package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	inPath := flag.String("in", "", "input JSON file (default: stdin)")
	brute := flag.Bool("brute", false, "also run exhaustive enumeration and check it agrees with the DP optimum")
	flag.Parse()

	var r io.Reader = os.Stdin
	if *inPath != "" {
		f, err := os.Open(*inPath)
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		r = f
	}

	var inst Instance
	if err := json.NewDecoder(r).Decode(&inst); err != nil {
		fatal(fmt.Errorf("decoding input: %w", err))
	}

	cert, err := Solve(&inst)
	if err != nil {
		fatal(err)
	}
	if err := Verify(&inst, cert); err != nil {
		fatal(fmt.Errorf("internal error: certificate failed verification: %w", err))
	}

	out := map[string]any{"certificate": cert}
	if *brute {
		best, err := BruteForce(&inst)
		if err != nil {
			fatal(err)
		}
		dp, _ := cert.TotalCostRat()
		out["brute_force_optimum"] = best.RatString()
		out["brute_force_matches_dp"] = best.Cmp(dp) == 0
		if best.Cmp(dp) != 0 {
			fatal(fmt.Errorf("DP optimum %s disagrees with brute force %s", dp.RatString(), best.RatString()))
		}
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "essplan:", err)
	os.Exit(1)
}
