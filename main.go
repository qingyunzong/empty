// depsolve is an offline dependency version solver.
//
// It reads a JSON instance (packages with up to 16 packages x 4 versions,
// dependency ranges, mutual-exclusion conflicts, root requirements and an
// optional lock file) from -input (default stdin) and prints a JSON result:
// a feasible certificate (selected versions) or a minimal conflict
// constraint set.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"depsolve/solver"
)

func main() {
	input := flag.String("input", "-", "input JSON file, or - for stdin")
	brute := flag.Bool("brute", false, "cross-check the result against full enumeration")
	flag.Parse()

	var data []byte
	var err error
	if *input == "-" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(*input)
	}
	if err != nil {
		fatal("read input: %v", err)
	}
	var inst solver.Instance
	if err := json.Unmarshal(data, &inst); err != nil {
		fatal("parse input: %v", err)
	}

	res, err := solver.Solve(&inst)
	if err != nil {
		fatal("solve: %v", err)
	}
	if *brute {
		if err := solver.CrossCheck(&inst); err != nil {
			fatal("cross-check failed: %v", err)
		}
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(res); err != nil {
		fatal("encode result: %v", err)
	}
}

func fatal(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "depsolve: "+format+"\n", args...)
	os.Exit(1)
}
