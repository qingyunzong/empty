// Command planner selects a minimum-cost assertion set that distinguishes
// every fault model from the normal model, and prints a coverage
// certificate verified by small-subset enumeration.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"assertplanner/internal/planner"
)

func main() {
	input := flag.String("input", "", "spec JSON file, or - for stdin (default: built-in 18x12 demo)")
	jsonOut := flag.Bool("json", false, "emit the certificate as JSON")
	flag.Parse()

	spec, err := loadSpec(*input)
	if err != nil {
		fatal("load spec: %v", err)
	}
	problem, err := planner.Compile(spec)
	if err != nil {
		fatal("invalid spec: %v", err)
	}
	cert, err := problem.Solve()
	if err != nil {
		fatal("solve: %v", err)
	}
	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(cert); err != nil {
			fatal("encode certificate: %v", err)
		}
		return
	}
	fmt.Print(cert.Format())
}

func loadSpec(input string) (planner.Spec, error) {
	if input == "" {
		return planner.DemoSpec(), nil
	}
	var r io.Reader
	if input == "-" {
		r = os.Stdin
	} else {
		f, err := os.Open(input)
		if err != nil {
			return planner.Spec{}, err
		}
		defer f.Close()
		r = f
	}
	var spec planner.Spec
	if err := json.NewDecoder(r).Decode(&spec); err != nil {
		return planner.Spec{}, err
	}
	return spec, nil
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "planner: "+format+"\n", args...)
	os.Exit(1)
}
