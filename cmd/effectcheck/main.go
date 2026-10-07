// Command effectcheck analyzes .fx source files and prints each
// function's inferred effect set plus diagnostics with source paths.
package main

import (
	"fmt"
	"os"
	"sort"

	"effectcheck"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: effectcheck <file.fx>...")
		os.Exit(2)
	}
	prog := &effectcheck.Program{}
	for _, path := range os.Args[1:] {
		data, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		p, err := effectcheck.Parse(path, string(data))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		prog.Globals = append(prog.Globals, p.Globals...)
		prog.Funcs = append(prog.Funcs, p.Funcs...)
	}
	res := effectcheck.Analyze(prog)
	names := make([]string, 0, len(res.Effects))
	for n := range res.Effects {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Printf("fn %s: %s\n", n, res.Effects[n])
	}
	for _, d := range res.Diagnostics {
		fmt.Println(d)
	}
	if len(res.Diagnostics) > 0 {
		os.Exit(1)
	}
}
