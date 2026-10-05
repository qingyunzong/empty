// Command sv verifies invariants over finite state tables (at most 8
// states, 5 events) with a step budget of at most 10.
//
// Usage:
//
//	sv check <model.json>   bounded check: shortest violating trace, or
//	                        "holds within bound" (NOT a global safety proof)
//	sv fair  <model.json>   fairness analysis: shortest fair infinite
//	                        violation (prefix + cycle), or complete SCC
//	                        evidence that none exists (global result)
//
// Input is read from the file argument, or stdin when omitted/"-" is given.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"statever"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	var r io.Reader = os.Stdin
	if len(os.Args) >= 3 && os.Args[2] != "-" {
		f, err := os.Open(os.Args[2])
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		r = f
	}
	m, err := statever.ParseModel(r)
	if err != nil {
		fatal(err)
	}
	switch cmd {
	case "check":
		runCheck(m)
	case "fair":
		runFair(m)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: sv check|fair [model.json]")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func runCheck(m *statever.Model) {
	res := statever.BoundedCheck(m)
	if res.Found() {
		fmt.Printf("VIOLATION within budget %d: shortest length %d\n", res.Budget, len(res.Violation))
		fmt.Println("trace:", statever.FormatTrace(m, res.Violation))
		os.Exit(1)
	}
	fmt.Printf("no violation within budget %d\n", res.Budget)
	fmt.Println("NOTE: bounded result only — the invariant holds for traces up to")
	fmt.Println("      this length; it is NOT proved to hold globally. Run 'sv fair'")
	fmt.Println("      for an exhaustive (SCC-based) analysis.")
}

func runFair(m *statever.Model) {
	res := statever.FairCheck(m)
	if res.Violation != nil {
		l := res.Violation
		if err := statever.VerifyFairLasso(m, l); err != nil {
			fatal(fmt.Errorf("internal: produced lasso failed verification: %w", err))
		}
		fmt.Println("FAIR VIOLATION: infinite counterexample (prefix + repeating cycle)")
		if len(l.Prefix) > 0 {
			fmt.Println("prefix:", statever.FormatTrace(m, l.Prefix))
		} else {
			fmt.Println("prefix: (empty, cycle starts at initial state)")
		}
		fmt.Println("cycle: ", statever.FormatTrace(m, l.Cycle), "  [repeats forever]")
		var states []int
		seen := map[int]bool{}
		for _, st := range l.Cycle {
			if !seen[st.From] {
				seen[st.From] = true
				states = append(states, st.From)
			}
		}
		var names []string
		for _, ev := range statever.ContinuouslyEnabled(m, states) {
			names = append(names, m.EventName(ev))
		}
		fmt.Printf("fairness: continuously ready events {%s} all occur in the cycle\n",
			strings.Join(names, ", "))
		os.Exit(1)
	}
	fmt.Println("NO FAIR VIOLATION — proved globally by complete SCC analysis")
	fmt.Println("(finite state table: every infinite fair behaviour is captured)")
	if !res.BadReachable {
		fmt.Println("invariant holds globally: no bad state is reachable at all")
	}
	fmt.Println("SCC evidence:")
	for _, ev := range res.Evidence {
		fmt.Printf("  SCC %d: states={%s} bad=%t fairCycle=%t reachableFromInitial=%t reachableFromBad=%t\n",
			ev.ID, strings.Join(ev.States, ","), ev.ContainsBad, ev.HasFairCycle,
			ev.ReachableFromInitial, ev.ReachableFromBad)
	}
}
