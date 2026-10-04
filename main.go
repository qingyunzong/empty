// Command taintcheck runs context-aware taint analysis over a finite
// control-flow graph described in JSON and prints every leak path.
//
// Usage:
//
//	taintcheck [-f graph.json] [-json]
//
// Input is read from stdin when -f is omitted. Exit code is 1 when at
// least one leak is found, 0 when clean, 2 on usage/input errors.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"

	"taintcheck/taint"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout))
}

func run(args []string, stdin io.Reader, stdout io.Writer) int {
	fs := flag.NewFlagSet("taintcheck", flag.ContinueOnError)
	fs.SetOutput(stdout)
	file := fs.String("f", "", "path to CFG JSON file (default: read from stdin)")
	asJSON := fs.Bool("json", false, "emit the report as JSON")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	var r io.Reader = stdin
	if *file != "" {
		f, err := os.Open(*file)
		if err != nil {
			fmt.Fprintf(stdout, "error: %v\n", err)
			return 2
		}
		defer f.Close()
		r = f
	}

	g, err := taint.Parse(r)
	if err != nil {
		fmt.Fprintf(stdout, "error: %v\n", err)
		return 2
	}

	res := g.Analyze()
	if *asJSON {
		writeJSON(stdout, res)
	} else {
		writeText(stdout, res)
	}
	if len(res.Leaks) > 0 {
		return 1
	}
	return 0
}

func writeText(w io.Writer, res *taint.Result) {
	fmt.Fprintf(w, "least fixpoint reached after %d pass(es)\n", res.Iterations)
	if len(res.CtrlDeps) > 0 {
		branches := make([]string, 0, len(res.CtrlDeps))
		for b := range res.CtrlDeps {
			branches = append(branches, b)
		}
		sort.Strings(branches)
		fmt.Fprintln(w, "control dependence (implicit flow):")
		for _, b := range branches {
			fmt.Fprintf(w, "  %s controls %v\n", b, res.CtrlDeps[b])
		}
	}
	if len(res.Leaks) == 0 {
		fmt.Fprintln(w, "no leaks found")
		return
	}
	fmt.Fprintf(w, "leaks: %d\n", len(res.Leaks))
	for i, l := range res.Leaks {
		fmt.Fprintf(w, "[%d] sink=%s var=%s ctx=%s\n    %s\n", i+1, l.Sink, l.Var, l.Ctx, l.PathString())
	}
}

type report struct {
	Iterations int          `json:"iterations"`
	Leaks      []leakReport `json:"leaks"`
}

type leakReport struct {
	Sink    string   `json:"sink"`
	Var     string   `json:"var"`
	Context string   `json:"context"`
	Path    []string `json:"path"`
}

func writeJSON(w io.Writer, res *taint.Result) {
	rep := report{Iterations: res.Iterations, Leaks: []leakReport{}}
	for _, l := range res.Leaks {
		lr := leakReport{Sink: l.Sink, Var: l.Var, Context: l.Ctx}
		for _, f := range l.Path {
			lr.Path = append(lr.Path, f.String())
		}
		rep.Leaks = append(rep.Leaks, lr)
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(rep)
}
