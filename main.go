// Command faircheck checks a small finite state table (at most 8 states,
// 5 events) for invariant violations within a step budget (at most 10) and
// for fair liveness violations (prefix+cycle lassos), with independent
// verification of every claim.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"faircheck/checker"
	"faircheck/verify"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout))
}

type boundedResult struct {
	Status string         `json:"status"` // "violated" | "holds_within_budget"
	Budget int            `json:"budget"`
	Note   string         `json:"note,omitempty"`
	Trace  *checker.Trace `json:"trace,omitempty"`
}

type exactResult struct {
	Status string         `json:"status"` // "safe" | "violated"
	Trace  *checker.Trace `json:"trace,omitempty"`
}

type fairResult struct {
	Status      string                `json:"status"` // "fair_violation" | "no_fair_cycle"
	Lasso       *checker.Lasso        `json:"lasso,omitempty"`
	SCCEvidence []checker.SCCEvidence `json:"scc_evidence,omitempty"`
}

type verification struct {
	LayeredEnumeration string `json:"layered_enumeration"`
	LassoUnrolling     string `json:"lasso_unrolling,omitempty"`
	SCCCheck           string `json:"scc_evidence_check,omitempty"`
}

type report struct {
	Budget        int           `json:"budget"`
	BoundedSafety boundedResult `json:"bounded_safety"`
	ExactSafety   exactResult   `json:"exact_safety"`
	Fairness      fairResult    `json:"fairness"`
	Verification  verification  `json:"verification"`
}

func run(args []string, stdin io.Reader, out io.Writer) int {
	fs := flag.NewFlagSet("faircheck", flag.ContinueOnError)
	fs.SetOutput(out)
	file := fs.String("file", "", "read the state table JSON from `file` (default: stdin)")
	budgetFlag := fs.Int("budget", -1, "step budget 0..10 (overrides the input file)")
	asJSON := fs.Bool("json", false, "print the report as JSON")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	var data []byte
	var err error
	if *file != "" {
		data, err = os.ReadFile(*file)
	} else {
		data, err = io.ReadAll(stdin)
	}
	if err != nil {
		fmt.Fprintf(out, "error: %v\n", err)
		return 2
	}
	var spec checker.Spec
	if err := json.Unmarshal(data, &spec); err != nil {
		fmt.Fprintf(out, "error: invalid JSON: %v\n", err)
		return 2
	}
	if *budgetFlag >= 0 {
		spec.Budget = budgetFlag
	}
	model, err := checker.NewModel(spec)
	if err != nil {
		fmt.Fprintf(out, "error: %v\n", err)
		return 2
	}
	budget := model.StepBudget()

	// 1. Bounded search: shortest violating trace within the budget.
	boundedTrace, boundedHit := model.ShortestViolation(budget)
	// 2. Exact safety over the finite graph: "no error within the budget"
	//    must never be reported as global safety.
	exactTrace, exactHit := model.ExactSafety()
	// 3. Fairness: shortest fair lasso, or complete SCC evidence.
	lasso, evidence, fairHit := model.FairViolation()

	rep := report{Budget: budget}
	if boundedHit {
		rep.BoundedSafety = boundedResult{Status: "violated", Budget: budget, Trace: &boundedTrace}
	} else {
		rep.BoundedSafety = boundedResult{
			Status: "holds_within_budget",
			Budget: budget,
			Note:   "bounded result only; not a proof of global safety",
		}
	}
	if exactHit {
		rep.ExactSafety = exactResult{Status: "violated", Trace: &exactTrace}
	} else {
		rep.ExactSafety = exactResult{Status: "safe"}
	}
	if fairHit {
		rep.Fairness = fairResult{Status: "fair_violation", Lasso: &lasso}
	} else {
		rep.Fairness = fairResult{Status: "no_fair_cycle", SCCEvidence: evidence}
	}
	rep.Verification = verifyAll(spec, budget, boundedTrace, boundedHit, lasso, evidence, fairHit)

	if *asJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		if err := enc.Encode(rep); err != nil {
			fmt.Fprintf(out, "error: %v\n", err)
			return 1
		}
	} else {
		printHuman(out, rep)
	}
	return 0
}

// verifyAll runs the independent checkers and summarizes their verdicts.
func verifyAll(spec checker.Spec, budget int, boundedTrace checker.Trace, boundedHit bool,
	lasso checker.Lasso, evidence []checker.SCCEvidence, fairHit bool) verification {
	var v verification

	enumSeq, enumHit := verify.LayeredMinViolation(spec, budget)
	switch {
	case enumHit != boundedHit:
		v.LayeredEnumeration = fmt.Sprintf("MISMATCH: layered enumeration hit=%v, bounded search hit=%v", enumHit, boundedHit)
	case !boundedHit:
		v.LayeredEnumeration = fmt.Sprintf("OK: no violating sequence of length <= %d (budget boundary confirmed)", budget)
	case !slices.Equal(enumSeq, boundedTrace.Events):
		v.LayeredEnumeration = fmt.Sprintf("MISMATCH: enumeration found %v, bounded search found %v", enumSeq, boundedTrace.Events)
	default:
		v.LayeredEnumeration = fmt.Sprintf("OK: minimum violating length %d confirmed (%s)", len(enumSeq), strings.Join(enumSeq, " "))
	}

	if fairHit {
		if err := verify.CheckLasso(spec, lasso, 3); err != nil {
			v.LassoUnrolling = "FAILED: " + err.Error()
		} else {
			v.LassoUnrolling = "OK: prefix+cycle unrolled x3; steps valid, goal-free, fair"
		}
	} else {
		var problems []string
		if witness, found := verify.CheckNoFairCycle(spec); found {
			problems = append(problems, fmt.Sprintf("independent search found a fair cycle on %v", witness))
		}
		if err := verify.CheckSCCEvidence(spec, evidence); err != nil {
			problems = append(problems, "SCC evidence: "+err.Error())
		}
		if len(problems) > 0 {
			v.SCCCheck = "FAILED: " + strings.Join(problems, "; ")
		} else {
			v.SCCCheck = "OK: no reachable fair cycle; SCC evidence complete and sound"
		}
	}
	return v
}

func formatTrace(t checker.Trace) string {
	if len(t.States) == 0 {
		return "(empty)"
	}
	var b strings.Builder
	b.WriteString(t.States[0])
	for i, e := range t.Events {
		fmt.Fprintf(&b, " -%s-> %s", e, t.States[i+1])
	}
	return b.String()
}

func printHuman(out io.Writer, rep report) {
	fmt.Fprintf(out, "budget: %d (max %d)\n\n", rep.Budget, checker.MaxBudget)

	fmt.Fprintln(out, "[bounded safety]")
	if rep.BoundedSafety.Status == "violated" {
		fmt.Fprintf(out, "  VIOLATED within budget: shortest trace (%d steps): %s\n",
			len(rep.BoundedSafety.Trace.Events), formatTrace(*rep.BoundedSafety.Trace))
	} else {
		fmt.Fprintf(out, "  no violation within %d steps — %s\n", rep.Budget, rep.BoundedSafety.Note)
	}

	fmt.Fprintln(out, "[exact safety] finite state graph, exhaustive")
	if rep.ExactSafety.Status == "violated" {
		fmt.Fprintf(out, "  VIOLATED: shortest trace (%d steps): %s\n",
			len(rep.ExactSafety.Trace.Events), formatTrace(*rep.ExactSafety.Trace))
	} else {
		fmt.Fprintln(out, "  SAFE: no bad state is reachable (global, not just within budget)")
	}

	fmt.Fprintln(out, "[fairness] liveness: goal states visited infinitely often")
	if rep.Fairness.Status == "fair_violation" {
		l := rep.Fairness.Lasso
		fmt.Fprintf(out, "  FAIR VIOLATION (infinite trace = prefix + cycle repeated forever):\n")
		fmt.Fprintf(out, "    prefix: %s\n", formatTrace(l.Prefix))
		fmt.Fprintf(out, "    cycle:  %s\n", formatTrace(l.Cycle))
		fmt.Fprintln(out, "    every continuously enabled event occurs in the cycle")
	} else {
		fmt.Fprintln(out, "  no reachable fair cycle; complete SCC evidence:")
		if len(rep.Fairness.SCCEvidence) == 0 {
			fmt.Fprintln(out, "    (no reachable goal-free states)")
		}
		for _, ev := range rep.Fairness.SCCEvidence {
			fmt.Fprintf(out, "    SCC {%s}: %s — %s\n", strings.Join(ev.States, ", "), ev.Kind, ev.Detail)
		}
	}

	fmt.Fprintln(out, "[independent verification]")
	fmt.Fprintf(out, "  layered enumeration: %s\n", rep.Verification.LayeredEnumeration)
	if rep.Verification.LassoUnrolling != "" {
		fmt.Fprintf(out, "  lasso unrolling:     %s\n", rep.Verification.LassoUnrolling)
	}
	if rep.Verification.SCCCheck != "" {
		fmt.Fprintf(out, "  SCC evidence check:  %s\n", rep.Verification.SCCCheck)
	}
}
