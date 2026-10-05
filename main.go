package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

const usage = `denydiag - diagnose why a request is rejected by layered interval rules

Usage: denydiag < input.txt

Input (stdin):
  line 1:   N Q                 N rules (0..18), rejected request Q
  next N:   ID LAYER ACTION LO HI
                                ACTION is allow|deny, interval [LO,HI] inclusive

Public semantics (inheritance layers + deny-priority, default ACCEPT):
  An ALLOW at layer L grants Q and the grant is inherited upward; a DENY at
  layer L revokes every grant from layers <= L (deny beats allow at the same
  layer). A DENY with no matching ALLOW is moot. Hence, with A = layers of
  matching allows and D = layers of matching denies:
      REJECT(Q)  <=>  A != {} and D != {} and max(D) >= max(A)

Output: a minimum-cardinality subset of rules that still rejects Q
(ties broken by ID order), plus an independent verification that every
strictly smaller subset fails to reject.
`

func run(stdout, stderr io.Writer, stdin io.Reader) int {
	rules, q, err := ParseInput(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "denydiag: %v\n", err)
		return 2
	}
	if !Rejected(rules, q) {
		fmt.Fprintf(stdout, "request %d is NOT rejected by the full rule set (%d rules); nothing to prove\n", q, len(rules))
		return 1
	}

	subset, ok := Solve(rules, q)
	if !ok {
		// Unreachable given the premise above, but keep the CLI total.
		fmt.Fprintln(stderr, "denydiag: internal error: full set rejects but no rejecting subset found")
		return 2
	}

	fmt.Fprintf(stdout, "verdict: request %d REJECTED by full rule set (%d rules)\n", q, len(rules))
	fmt.Fprintf(stdout, "minimal proof: %d rule(s)\n", len(subset))
	ids := make([]int, len(subset))
	for i, r := range subset {
		ids[i] = r.ID
	}
	fmt.Fprintf(stdout, "rule ids: %v\n", ids)
	for _, r := range subset {
		fmt.Fprintf(stdout, "  %s\n", r)
	}
	fmt.Fprintf(stdout, "explanation: %s\n", Explain(subset, q))

	total := 1 << len(rules)
	checked, minimal := VerifyMinimality(rules, q, len(subset))
	if !minimal {
		fmt.Fprintln(stderr, "denydiag: internal error: independent minimality check failed")
		return 2
	}
	fmt.Fprintf(stdout, "verification: exhaustive acceptance evaluated all %d subsets; independent check confirmed no subset of size < %d rejects (%d subset(s) checked)\n",
		total, len(subset), checked)
	return 0
}

func main() {
	semantics := flag.Bool("semantics", false, "print the public rule semantics and exit")
	flag.Usage = func() { fmt.Fprint(flag.CommandLine.Output(), usage) }
	flag.Parse()
	if *semantics {
		fmt.Print(usage)
		return
	}
	os.Exit(run(os.Stdout, os.Stderr, os.Stdin))
}
