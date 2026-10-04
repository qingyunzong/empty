// Command protocheck tests an implementation against a finite protocol
// state table: it generates legal action histories up to n steps, locates
// a goal state by its shortest history, reports state differences, and
// verifies that illegal actions fail without changing state.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"protocheck"
)

func main() {
	tablePath := flag.String("table", "", "path to protocol state table (JSON)")
	goal := flag.String("goal", "", "goal state to locate via shortest history (optional)")
	n := flag.Int("n", 5, "max steps (exploration budget)")
	adapterKind := flag.String("adapter", "sim", "adapter kind: sim | exec")
	cmdStr := flag.String("cmd", "", "command to run for the exec adapter")
	noIllegal := flag.Bool("no-illegal", false, "skip illegal action checks")
	list := flag.Bool("list", false, "list generated legal histories up to n steps and exit")
	reportPath := flag.String("report", "", "also write the report to this file")
	flag.Parse()

	if *tablePath == "" {
		fmt.Fprintln(os.Stderr, "-table is required")
		os.Exit(3)
	}
	table, err := protocheck.LoadTable(*tablePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}

	if *list {
		for _, h := range table.GenerateHistories(*n) {
			fmt.Printf("[%s]\n", strings.Join(h, ", "))
		}
		return
	}

	var ad protocheck.Adapter
	switch *adapterKind {
	case "sim":
		ad = protocheck.NewSimAdapter(table)
	case "exec":
		if *cmdStr == "" {
			fmt.Fprintln(os.Stderr, "-cmd is required for the exec adapter")
			os.Exit(3)
		}
		fields := strings.Fields(*cmdStr)
		ea, err := protocheck.NewExecAdapter(fields[0], fields[1:]...)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(3)
		}
		defer ea.Close()
		ad = ea
	default:
		fmt.Fprintf(os.Stderr, "unknown adapter %q\n", *adapterKind)
		os.Exit(3)
	}

	rep := protocheck.Run(table, ad, protocheck.Options{
		Goal:         *goal,
		MaxSteps:     *n,
		CheckIllegal: !*noIllegal,
	})
	out := rep.String()
	fmt.Print(out)
	if *reportPath != "" {
		if err := os.WriteFile(*reportPath, []byte(out), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(3)
		}
	}
	switch rep.Verdict {
	case protocheck.VerdictPass:
		os.Exit(0)
	case protocheck.VerdictFail:
		os.Exit(1)
	default:
		os.Exit(2)
	}
}
