package wf_test

import (
	"fmt"

	"example.org/dataeng/q0314/wf"
)

// ExampleEvaluate is the pipeline integration sketch: instantiate a ground
// program once, evaluate it, consume the three-valued partition and the
// per-round audit material, then replace the whole snapshot when facts change.
func ExampleEvaluate() {
	universe := []string{"a", "b", "c"}
	rules := []wf.Rule{
		{ID: "r1", Head: "a", Neg: []string{"b"}},
		{ID: "r2", Head: "b", Neg: []string{"a"}},
		{ID: "r3", Head: "c", Pos: []string{"a"}},
	}

	program, err := wf.NewProgram(universe, rules)
	if err != nil {
		panic(err)
	}
	result := wf.Evaluate(program)

	fmt.Printf("true=%v\n", result.True)
	fmt.Printf("unknown=%v\n", result.Unknown)
	fmt.Printf("false=%v\n", result.False)
	fmt.Printf("rounds=%d\n", len(result.Rounds))

	first := result.Rounds[0]
	fmt.Printf("gammaK_S=%v closure=%v removals=%v erasures=%v\n",
		first.KTrace.S, first.KTrace.Closure, first.KTrace.Removals, first.KTrace.Erasures)
	for _, support := range result.FalseSupports {
		if support.NoRules {
			fmt.Printf("support %s: no rule\n", support.Head)
		}
		for _, witness := range support.Witnesses {
			fmt.Printf("support %s: rule %s blocked by %s %s\n",
				support.Head, witness.RuleID, witness.Kind, witness.Atom)
		}
	}

	// Replacing the facts means building a new snapshot; the old result stays
	// valid and immutable.
	replacement, err := wf.NewProgram(universe, append(rules, wf.Rule{ID: "fact-a", Head: "a"}))
	if err != nil {
		panic(err)
	}
	recomputed := wf.Evaluate(replacement)
	fmt.Printf("recomputed true=%v false=%v unknown=%v\n",
		recomputed.True, recomputed.False, recomputed.Unknown)
	// Output:
	// true=[]
	// unknown=[a b c]
	// false=[]
	// rounds=1
	// gammaK_S=[a b c] closure=[] removals=[{r1 b} {r2 a}] erasures=[]
	// recomputed true=[a c] false=[b] unknown=[]
}
