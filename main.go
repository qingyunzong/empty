// Command berthsched reads a berth scheduling problem as JSON and prints
// an optimal schedule (minimum total waiting time) as JSON.
//
// Usage:
//
//	berthsched [-input file.json] [-brute]
//
// Input is read from stdin when -input is omitted. All times are absolute
// minutes and occupancies are half-open intervals [start, end).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("berthsched", flag.ContinueOnError)
	input := fs.String("input", "", "input JSON file (default: stdin)")
	brute := fs.Bool("brute", false, "use exhaustive brute-force solver instead of branch-and-bound")
	if err := fs.Parse(args); err != nil {
		return err
	}
	var data []byte
	var err error
	if *input != "" {
		data, err = os.ReadFile(*input)
	} else {
		data, err = io.ReadAll(stdin)
	}
	if err != nil {
		return err
	}
	var p Problem
	if err := json.Unmarshal(data, &p); err != nil {
		return fmt.Errorf("parse input: %w", err)
	}
	sol, err := Solve(p, *brute)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(sol)
}
