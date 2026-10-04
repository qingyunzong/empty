// Command queuecheck diagnoses a history of at most 12 queue operations
// (with call/return times) and decides whether it admits a serial
// explanation consistent with the real-time order: operations that do
// not overlap in time must keep their order, overlapping operations may
// be reordered freely, and operations that never returned (pending) may
// be omitted or completed arbitrarily.
//
// Usage:
//
//	queuecheck [history-file]     (reads stdin when no file is given)
//
// Input format, one operation per line:
//
//	enq <value> <call> <ret|->
//	deq <value|-> <call> <ret|->
//
// '-' as a deq value means it returned empty; '-' as a return time marks
// a pending operation. Blank lines and '#' comments are ignored.
//
// Exit codes: 0 = linearizable (witness printed), 1 = not linearizable
// (exhaustive), 2 = usage/parse/internal error.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

func main() {
	os.Exit(run(os.Args, os.Stdin, os.Stdout, os.Stderr))
}

func run(argv []string, stdin io.Reader, stdout, stderr io.Writer) int {
	var src io.Reader = stdin
	name := "<stdin>"
	if len(argv) > 2 {
		fmt.Fprintln(stderr, "usage: queuecheck [history-file]")
		return 2
	}
	if len(argv) == 2 {
		f, err := os.Open(argv[1])
		if err != nil {
			fmt.Fprintln(stderr, "error:", err)
			return 2
		}
		defer f.Close()
		src = f
		name = argv[1]
	}

	ops, err := ParseHistory(src)
	if err != nil {
		fmt.Fprintf(stderr, "error: %s: %v\n", name, err)
		return 2
	}

	fmt.Fprintf(stdout, "history: %d operations from %s\n", len(ops), name)
	for _, op := range ops {
		fmt.Fprintln(stdout, "  ", op.String())
	}

	witness, ok := Solve(ops)
	brute := BruteForce(ops)
	if ok != brute.Linearizable {
		fmt.Fprintf(stderr, "internal error: solvers disagree (primary=%v, brute=%v)\n", ok, brute.Linearizable)
		return 2
	}

	if !ok {
		fmt.Fprintln(stdout, "\nNOT LINEARIZABLE: no serial explanation respects the real-time order.")
		fmt.Fprintln(stdout, "  primary solver: exhaustive memoized search found no witness.")
		fmt.Fprintf(stdout, "  independent check: enumerated %d omission subsets x permutations (%d fully simulated), none valid.\n",
			brute.Subsets, brute.Permutations)
		return 1
	}

	fmt.Fprintln(stdout, "\nLINEARIZABLE: one serial explanation (witness):")
	for pos, st := range witness {
		op := ops[st.Op]
		fmt.Fprintf(stdout, "  %2d. %s", pos+1, op.String())
		var notes []string
		if op.Pending {
			if st.Omitted {
				notes = append(notes, "pending, omitted")
			} else if op.Kind == Deq {
				res := st.DeqVal
				if st.DeqEmpty {
					res = "empty"
				}
				notes = append(notes, "pending, completed -> "+res)
			} else {
				notes = append(notes, "pending, completed")
			}
		}
		if len(notes) > 0 {
			fmt.Fprintf(stdout, "   [%s]", strings.Join(notes, "; "))
		}
		fmt.Fprintln(stdout)
	}
	fmt.Fprintf(stdout, "  cross-check: independent enumeration agrees (subsets=%d, permutations simulated=%d).\n",
		brute.Subsets, brute.Permutations)
	return 0
}
