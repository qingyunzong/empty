package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	verify := flag.Bool("verify", true,
		"cross-check acyclic types against the expanded reference model")
	flag.Parse()

	var (
		src []byte
		err error
	)
	if flag.NArg() > 0 {
		src, err = os.ReadFile(flag.Arg(0))
	} else {
		src, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "ifacecheck:", err)
		os.Exit(2)
	}
	prog, err := Parse(string(src))
	if err != nil {
		fmt.Fprintln(os.Stderr, "ifacecheck:", err)
		os.Exit(2)
	}
	if len(prog.Checks) == 0 {
		fmt.Fprintln(os.Stderr, "ifacecheck: no check statements in input")
		os.Exit(2)
	}

	exit := 0
	for _, c := range prog.Checks {
		sub := prog.Types[c.Sub]
		sup := prog.Types[c.Sup]
		res := Check(sub, sup)
		if res.OK {
			fmt.Printf("check %s <: %s: COMPATIBLE\n", c.Sub, c.Sup)
		} else {
			fmt.Printf("check %s <: %s: INCOMPATIBLE at %s: %s\n",
				c.Sub, c.Sup, PathString(res.Path), res.Reason)
			exit = 1
		}
		if *verify {
			note, consistent := CrossCheck(sub, sup, res.OK)
			fmt.Printf("  %s\n", note)
			if !consistent {
				exit = 2
			}
		}
	}
	os.Exit(exit)
}
