// permplan is a permission-planning CLI: it reads a JSON spec of allow rules,
// forbidden actions and action demands, then emits a JSON report with the
// minimum-cost rule selection, per-rule usage, certificates, bounds, and
// independent enumeration cross-checks.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"permplan/planner"
)

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("permplan", flag.ContinueOnError)
	in := fs.String("in", "", "input spec JSON file (default: stdin)")
	out := fs.String("out", "", "output report JSON file (default: stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	var r io.Reader = stdin
	if *in != "" {
		f, err := os.Open(*in)
		if err != nil {
			return err
		}
		defer f.Close()
		r = f
	}
	spec, err := planner.ParseSpec(r)
	if err != nil {
		return fmt.Errorf("invalid spec: %w", err)
	}
	rep, err := planner.Plan(spec)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	var w io.Writer = stdout
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			return err
		}
		defer f.Close()
		w = f
	}
	_, err = w.Write(data)
	return err
}

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "permplan:", err)
		os.Exit(1)
	}
}
