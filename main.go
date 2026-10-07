// Command depsolve solves offline dependency resolution problems.
//
// Input (JSON, from a file argument or stdin):
//
//	{
//	  "packages":     [{"name": "a", "versions": ["1.0.0", "2.0.0"]}, ...],
//	  "dependencies": [{"from": "a", "from_version": "2.0.0", "to": "b", "range": ">=1.0.0 <2.0.0"}],
//	  "conflicts":    [{"package": "a", "version": "1.0.0", "with": "c", "with_range": ">=3.0.0"}],
//	  "roots":        [{"name": "a", "range": ">=1.0.0"}],
//	  "lock":         {"a": "1.0.0"}
//	}
//
// Limits: at most 16 packages with at most 4 versions each. The solver
// picks exactly one version per package, minimizing the number of versions
// changed versus the lock file, then preferring the highest versions.
//
// Output (JSON): a feasibility certificate (the selected assignment) or a
// minimal conflict constraint set explaining infeasibility.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"depsolve/solver"
)

type result struct {
	Status   string            `json:"status"` // "feasible" or "infeasible"
	Solution map[string]string `json:"solution,omitempty"`
	Changes  *int              `json:"changes,omitempty"`
	Conflict []string          `json:"conflict,omitempty"`
	BruteOK  *bool             `json:"brute_force_agrees,omitempty"`
}

func main() {
	file := flag.String("file", "", "input JSON file (default: stdin)")
	brute := flag.Bool("brute", false, "cross-check with exhaustive enumeration (small instances)")
	flag.Parse()

	var data []byte
	var err error
	if *file != "" {
		data, err = os.ReadFile(*file)
	} else {
		data, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		fatal("read input: %v", err)
	}
	var in solver.Input
	if err := json.Unmarshal(data, &in); err != nil {
		fatal("parse input: %v", err)
	}
	if in.Lock == nil {
		in.Lock = map[string]string{}
	}
	if err := in.Validate(); err != nil {
		fatal("invalid input: %v", err)
	}

	var res result
	asgn, ok := solver.Solve(&in)
	if ok {
		if err := solver.Verify(&in, asgn); err != nil {
			fatal("internal error: solver produced invalid certificate: %v", err)
		}
		changes := 0
		for name, lv := range in.Lock {
			if asgn[name] != lv {
				changes++
			}
		}
		res = result{
			Status:   "feasible",
			Solution: map[string]string(asgn),
			Changes:  &changes,
		}
	} else {
		set, err := solver.MinimalConflict(&in)
		if err != nil {
			fatal("extract conflict set: %v", err)
		}
		res = result{Status: "infeasible", Conflict: set.Constraints}
	}

	if *brute {
		br, err := solver.BruteForce(&in)
		if err != nil {
			fatal("brute force: %v", err)
		}
		agree := br.Feasible == ok
		if agree && ok {
			agree = fmt.Sprint(map[string]string(br.Best)) == fmt.Sprint(res.Solution)
		}
		res.BruteOK = &agree
		if !agree {
			printJSON(res)
			fatal("brute force cross-check disagrees with solver")
		}
	}

	printJSON(res)
	if !ok {
		os.Exit(1)
	}
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	enc.Encode(v)
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "depsolve: "+format+"\n", args...)
	os.Exit(2)
}
