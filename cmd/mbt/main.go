// Command mbt generates legal action sequences from a finite protocol
// state table and checks an implementation adapter against them.
//
// Usage:
//
//	mbt run -model model.json -n 5 -- ./my-adapter [args...]
//
// The adapter is a subprocess speaking JSON lines: one Request per line
// on stdin, one Response per line on stdout (see package mbt).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"mbt/mbt"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run executes the CLI and returns the process exit code:
// 0 = PASS, 1 = FAIL, 2 = usage/IO error, 3 = INCONCLUSIVE (budget open).
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) < 1 || args[0] != "run" {
		fmt.Fprintln(stderr, "usage: mbt run -model model.json -n N -- cmd [args...]")
		return 2
	}
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	modelPath := fs.String("model", "", "path to state table JSON (required)")
	maxSteps := fs.Int("n", 5, "max actions per generated sequence (step budget)")
	reportPath := fs.String("report", "", "write JSON report here instead of stdout")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	argv := fs.Args()
	if len(argv) > 0 && argv[0] == "--" {
		argv = argv[1:]
	}
	if *modelPath == "" || len(argv) == 0 {
		fmt.Fprintln(stderr, "error: -model and adapter command are required")
		return 2
	}

	model, err := mbt.LoadModel(*modelPath)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	plan := mbt.NewExplorer(model).Generate(*maxSteps)
	for _, s := range plan.Unreachable {
		fmt.Fprintf(stderr, "warning: state %s unreachable from %s\n", s, model.Initial)
	}
	for _, t := range plan.Uncovered {
		fmt.Fprintf(stderr, "warning: transition %s -%s-> %s needs more than %d steps\n",
			t.From, t.Action, t.To, *maxSteps)
	}

	adapter, err := mbt.NewExecAdapter(argv...)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	defer adapter.Close()

	report := mbt.NewRunner(model, adapter).Run(plan, *maxSteps)

	out, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	if *reportPath != "" {
		if err := os.WriteFile(*reportPath, append(out, '\n'), 0o644); err != nil {
			fmt.Fprintln(stderr, "error:", err)
			return 2
		}
	} else {
		fmt.Fprintln(stdout, string(out))
	}
	fmt.Fprintf(stderr, "verdict: %s (budget_closed=%v, failures=%d)\n",
		report.Verdict, report.Closed, len(report.Failures))

	switch report.Verdict {
	case "PASS":
		return 0
	case "INCONCLUSIVE":
		return 3 // budget not closed: explicitly not a pass
	default:
		return 1
	}
}
