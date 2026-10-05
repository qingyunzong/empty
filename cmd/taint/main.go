// Command taint runs a taint analysis over a limited control-flow graph
// described in JSON. It prints the least fixed-point state of every node
// and every leaking path found by bounded graph expansion.
//
// Usage:
//
//	taint [-unroll N] program.json
//	cat program.json | taint
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"taintcli/taint"
)

func main() {
	unroll := flag.Int("unroll", 2, "max visits per node when expanding paths (loop unroll bound)")
	flag.Parse()

	var r io.Reader = os.Stdin
	if flag.NArg() == 1 {
		f, err := os.Open(flag.Arg(0))
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		r = f
	} else if flag.NArg() > 1 {
		fmt.Fprintln(os.Stderr, "usage: taint [-unroll N] [program.json]")
		os.Exit(2)
	}

	prog, err := taint.Load(r)
	if err != nil {
		fatal(err)
	}

	a := taint.NewAnalyzer(prog)
	a.Run()

	fmt.Println("== fixed-point states ==")
	for _, id := range prog.IDs() {
		fmt.Printf("%-8s in: %s\n", id, a.In[id])
	}

	leaks := a.Leaks()
	fmt.Println("\n== leaks (fixed point) ==")
	if len(leaks) == 0 {
		fmt.Println("none")
	}
	for _, l := range leaks {
		fmt.Println(l)
	}

	fmt.Printf("\n== leak paths (graph expansion, unroll=%d) ==\n", *unroll)
	paths := a.ExpandPaths(*unroll)
	if len(paths) == 0 {
		fmt.Println("none")
	}
	for i, p := range paths {
		fmt.Printf("path %d: %s\n", i+1, p)
		for _, e := range p.Events {
			fmt.Printf("    %s\n", e)
		}
	}

	if len(leaks) > 0 {
		os.Exit(1)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "taint:", err)
	os.Exit(2)
}
