// Command signal solves traffic-signal cycle optimization problems.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"signalcli/internal/signal"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	switch args[0] {
	case "solve":
		return cmdSolve(args[1:], stdout, stderr)
	case "exhaustive":
		return cmdExhaustive(args[1:], stdout, stderr)
	case "verify":
		return cmdVerify(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", args[0])
		usage(stderr)
		return 2
	}
}

func usage(w io.Writer) {
	fmt.Fprint(w, `signal - exact traffic-signal cycle optimizer

Usage:
  signal solve      -f problem.json [-o cert.json] [-max-states N]
  signal exhaustive -f problem.json [-o cert.json] [-max-enum N]
  signal verify     -f problem.json -c cert.json [-max-enum N]

Model: a cycle of C<=60 integer slots; each slot may release any
conflict-free set of phases; phase i must be green for at least min[i]
slots; total cost = sum_i cost_i[green_i] is minimized.

solve      exact dynamic-programming optimizer, prints a certificate
exhaustive brute-force oracle for tiny cycles (optimality cross-check)
verify     check a certificate; for tiny cycles also confirms optimality
`)
}

func writeCert(cert *signal.Certificate, outPath string, stdout io.Writer) error {
	data, err := json.MarshalIndent(cert, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if outPath == "" || outPath == "-" {
		_, err = stdout.Write(data)
		return err
	}
	return os.WriteFile(outPath, data, 0o644)
}

func cmdSolve(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("solve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	in := fs.String("f", "", "problem JSON file (required)")
	out := fs.String("o", "", "certificate output file (default stdout)")
	maxStates := fs.Int("max-states", 4000000, "state-space limit for the DP solver")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *in == "" {
		fmt.Fprintln(stderr, "solve: -f is required")
		return 2
	}
	p, err := signal.LoadProblem(*in)
	if err != nil {
		fmt.Fprintln(stderr, "solve:", err)
		return 1
	}
	cert, err := signal.Solve(p, *maxStates)
	if err != nil {
		fmt.Fprintln(stderr, "solve:", err)
		return 1
	}
	if err := writeCert(cert, *out, stdout); err != nil {
		fmt.Fprintln(stderr, "solve:", err)
		return 1
	}
	return 0
}

func cmdExhaustive(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("exhaustive", flag.ContinueOnError)
	fs.SetOutput(stderr)
	in := fs.String("f", "", "problem JSON file (required)")
	out := fs.String("o", "", "certificate output file (default stdout)")
	maxEnum := fs.Int64("max-enum", 5000000, "multiset enumeration limit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *in == "" {
		fmt.Fprintln(stderr, "exhaustive: -f is required")
		return 2
	}
	p, err := signal.LoadProblem(*in)
	if err != nil {
		fmt.Fprintln(stderr, "exhaustive:", err)
		return 1
	}
	cert, err := signal.Exhaustive(p, *maxEnum)
	if err != nil {
		fmt.Fprintln(stderr, "exhaustive:", err)
		return 1
	}
	if err := writeCert(cert, *out, stdout); err != nil {
		fmt.Fprintln(stderr, "exhaustive:", err)
		return 1
	}
	return 0
}

type verifyResult struct {
	Feasible bool   `json:"feasible"`
	Cost     int    `json:"cost"`
	Optimal  *bool  `json:"optimal,omitempty"`
	Note     string `json:"note,omitempty"`
}

func cmdVerify(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	in := fs.String("f", "", "problem JSON file (required)")
	certPath := fs.String("c", "", "certificate JSON file (required)")
	maxEnum := fs.Int64("max-enum", 2000000, "multiset enumeration limit for the optimality cross-check")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *in == "" || *certPath == "" {
		fmt.Fprintln(stderr, "verify: -f and -c are required")
		return 2
	}
	p, err := signal.LoadProblem(*in)
	if err != nil {
		fmt.Fprintln(stderr, "verify:", err)
		return 1
	}
	data, err := os.ReadFile(*certPath)
	if err != nil {
		fmt.Fprintln(stderr, "verify:", err)
		return 1
	}
	var cert signal.Certificate
	if err := json.Unmarshal(data, &cert); err != nil {
		fmt.Fprintln(stderr, "verify: parsing certificate:", err)
		return 1
	}
	if err := signal.Check(p, &cert); err != nil {
		fmt.Fprintln(stderr, "verify: INFEASIBLE:", err)
		return 1
	}
	res := verifyResult{Feasible: true, Cost: cert.Cost}
	ex, err := signal.Exhaustive(p, *maxEnum)
	switch {
	case err != nil:
		res.Note = "feasible; cycle too large for exhaustive optimality check"
	case ex.Cost == cert.Cost:
		t := true
		res.Optimal = &t
		res.Note = "optimality confirmed by exhaustive enumeration"
	default:
		f := false
		res.Optimal = &f
		res.Note = fmt.Sprintf("certificate cost %d is NOT optimal; exhaustive optimum is %d", cert.Cost, ex.Cost)
	}
	out, _ := json.MarshalIndent(res, "", "  ")
	fmt.Fprintln(stdout, string(out))
	if res.Optimal != nil && !*res.Optimal {
		return 1
	}
	return 0
}
