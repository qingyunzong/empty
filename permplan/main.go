// Command permplan plans minimum-cost permission rule selections.
//
// Usage:
//
//	permplan solve  -in instance.json [-out cert.json]
//	permplan verify -in instance.json -cert cert.json
//
// The instance JSON describes allow rules (id, cost, use_cost, capacity,
// actions), mutex pairs, enable prerequisites, a global action quota, a
// multiset of action demands, and forbidden actions. `solve` emits a
// certificate JSON with the optimal selection, per-rule usage, demand
// coverage, forbidden-action and dependency checks, budget bounds, and
// brute-force enumeration cross-checks. `verify` re-checks a certificate
// against its instance.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"permplan/internal/planner"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "solve":
		err = cmdSolve(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "permplan: "+err.Error())
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  permplan solve  -in instance.json [-out cert.json]
  permplan verify -in instance.json -cert cert.json`)
}

func readInput(path string) (*planner.Input, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var in planner.Input
	if err := json.Unmarshal(data, &in); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if err := in.Validate(); err != nil {
		return nil, fmt.Errorf("invalid instance: %w", err)
	}
	return &in, nil
}

func cmdSolve(args []string) error {
	fs := flag.NewFlagSet("solve", flag.ContinueOnError)
	inPath := fs.String("in", "", "instance JSON file (required)")
	outPath := fs.String("out", "", "write certificate JSON here (default: stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *inPath == "" {
		return fmt.Errorf("-in is required")
	}
	in, err := readInput(*inPath)
	if err != nil {
		return err
	}
	cert, err := planner.BuildCertificate(in)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(cert, "", "  ")
	if err != nil {
		return err
	}
	if *outPath == "" {
		fmt.Println(string(data))
		return nil
	}
	return os.WriteFile(*outPath, append(data, '\n'), 0o644)
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	inPath := fs.String("in", "", "instance JSON file (required)")
	certPath := fs.String("cert", "", "certificate JSON file (required)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *inPath == "" || *certPath == "" {
		return fmt.Errorf("-in and -cert are required")
	}
	in, err := readInput(*inPath)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(*certPath)
	if err != nil {
		return err
	}
	var cert planner.Certificate
	if err := json.Unmarshal(data, &cert); err != nil {
		return fmt.Errorf("parsing %s: %w", *certPath, err)
	}
	problems := planner.CheckCertificate(in, &cert)
	if len(problems) > 0 {
		for _, p := range problems {
			fmt.Fprintln(os.Stderr, "INVALID: "+p)
		}
		return fmt.Errorf("certificate rejected: %d problem(s)", len(problems))
	}
	fmt.Println("certificate valid")
	return nil
}
