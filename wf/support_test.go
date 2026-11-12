package wf

import "testing"

// A false cycle atom may have one rule supported inside the collective cycle
// and another rule blocked by an external false atom; both witness flavors must
// be reported, with only the former marked InCycle.
func TestMixedCycleAndExternalWitness(t *testing.T) {
	rules := []Rule{
		{ID: "cycle-a", Head: "a", Pos: []string{"b"}},
		{ID: "cycle-b", Head: "b", Pos: []string{"a"}},
		{ID: "external-a", Head: "a", Pos: []string{"x"}},
		{ID: "neg-a", Head: "a", Neg: []string{"t"}},
		{ID: "fact-t", Head: "t"},
	}
	res := assertScenario(t, "mixed witnesses",
		[]string{"a", "b", "t", "x"}, rules,
		[]string{"t"}, []string{"a", "b", "x"}, nil)

	var inCycle, externalFalse, negTrue int
	for _, support := range res.FalseSupports {
		if support.Head != "a" {
			continue
		}
		for _, w := range support.Witnesses {
			switch {
			case w.Kind == "pos_false" && w.Atom == "b" && w.InCycle:
				inCycle++
			case w.Kind == "pos_false" && w.Atom == "x" && !w.InCycle:
				externalFalse++
			case w.Kind == "neg_true" && w.Atom == "t" && !w.InCycle:
				negTrue++
			}
		}
	}
	if inCycle != 1 || externalFalse != 1 || negTrue != 1 {
		t.Fatalf("witness breakdown wrong: cycle=%d external=%d negTrue=%d", inCycle, externalFalse, negTrue)
	}
}

// Empty programs are legal: every atom without a definition is false, and an
// empty universe yields empty sorted partitions and one Gamma-less-but-valid
// round structure.
func TestEmptyAndUndefinedPrograms(t *testing.T) {
	res := assertScenario(t, "all undefined",
		[]string{"x", "y"}, nil,
		nil, []string{"x", "y"}, nil)
	for _, support := range res.FalseSupports {
		if !support.NoRules {
			t.Fatalf("undefined atom %s must be NoRules", support.Head)
		}
	}

	empty := mustProgram(t, nil, nil)
	emptyRes := Evaluate(empty)
	if len(emptyRes.True) != 0 || len(emptyRes.False) != 0 || len(emptyRes.Unknown) != 0 {
		t.Fatalf("empty universe must give empty partitions, got %+v", emptyRes)
	}
	if len(emptyRes.Rounds) != 1 || len(emptyRes.Rounds[0].KTrace.Closure) != 0 {
		t.Fatalf("empty closure is legal but must still be recorded")
	}
}
