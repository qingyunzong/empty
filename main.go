// Command signal computes a minimum-cost integer signal timing plan.
//
// Each phase needs an integer number of green slots within a fixed cycle
// (at most 60), conflicting phases may never be green in the same slot,
// and each phase carries a waiting-cost table indexed by green slots.
// The tool prints a complete, self-checking cycle certificate and can
// cross-check the optimizer against exhaustive enumeration on tiny cycles.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "signal:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("signal", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	file := fs.String("f", "", "instance JSON file (default: stdin)")
	verify := fs.Bool("verify", false, "cross-check against exhaustive enumeration (tiny cycles only)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	var r io.Reader = stdin
	if *file != "" {
		f, err := os.Open(*file)
		if err != nil {
			return err
		}
		defer f.Close()
		r = f
	}
	inst, err := LoadInstance(r)
	if err != nil {
		return err
	}

	alloc, slots, total, ok := Solve(inst)
	if !ok {
		return fmt.Errorf("no feasible plan: minimum green times exceed the cycle capacity")
	}
	cert, err := BuildCertificate(inst, alloc, slots)
	if err != nil {
		return fmt.Errorf("internal error: %w", err)
	}
	fmt.Fprint(stdout, cert.String(inst))

	if *verify {
		best, bruteTotal, checked, feasible, ok := BruteForce(inst)
		if !ok {
			return fmt.Errorf("exhaustive check found no feasible plan, optimizer reported %d", total)
		}
		fmt.Fprintf(stdout, "EXHAUSTIVE allocations=%d feasible=%d optimum=%d\n", checked, feasible, bruteTotal)
		if bruteTotal != total {
			return fmt.Errorf("MISMATCH: optimizer=%d exhaustive=%d (alloc %v)", total, bruteTotal, best)
		}
		fmt.Fprintln(stdout, "EXHAUSTIVE match: optimizer optimum confirmed")
	}
	return nil
}
