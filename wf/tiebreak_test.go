package wf

import "testing"

// Ready rules are taken in rule-ID ASCII order, not in insertion order.
func TestReadyRulesTieBrokenByRuleID(t *testing.T) {
	rules := []Rule{
		{ID: "z-rule", Head: "z", Pos: []string{"f"}},
		{ID: "a-rule", Head: "a", Pos: []string{"f"}},
		{ID: "m-rule", Head: "m", Pos: []string{"f"}},
		{ID: "fact-f", Head: "f"},
	}
	res := assertScenario(t, "rule id tie break",
		[]string{"a", "f", "m", "z"}, rules,
		[]string{"a", "f", "m", "z"}, nil, nil)

	seq := map[string]int{}
	for _, d := range res.Rounds[0].KTrace.Derivations {
		seq[d.Head] = d.Seq
	}
	if seq["f"] != 1 || seq["a"] != 2 || seq["m"] != 3 || seq["z"] != 4 {
		t.Fatalf("ready rules must fire in rule ID ASCII order, got %v", seq)
	}
}

// Newly activated atoms are processed in atom-ID ASCII order; facts queued
// together must activate their dependents through the smallest atom first.
func TestPendingAtomsTieBrokenByAtomID(t *testing.T) {
	rules := []Rule{
		{ID: "fact-b", Head: "b"},
		{ID: "fact-a", Head: "a"},
		{ID: "rule-c", Head: "c", Pos: []string{"b"}},
		{ID: "rule-d", Head: "d", Pos: []string{"a"}},
	}
	res := assertScenario(t, "atom id tie break",
		[]string{"a", "b", "c", "d"}, rules,
		[]string{"a", "b", "c", "d"}, nil, nil)

	seq := map[string]int{}
	for _, d := range res.Rounds[0].KTrace.Derivations {
		seq[d.Head] = d.Seq
	}
	// Both facts are ready initially; smallest rule ID fires first, but the
	// pending atom queue then always activates the smallest available atom.
	if seq["a"] != 1 || seq["b"] != 2 || seq["d"] != 3 || seq["c"] != 4 {
		t.Fatalf("pending atoms must advance in atom ID ASCII order, got %v", seq)
	}
}

// An already-derived head blocks a second rule from firing, so no rule can be
// credited with a circular derivation.
func TestNoCircularDerivation(t *testing.T) {
	rules := []Rule{
		{ID: "fact-a", Head: "a"},
		{ID: "loop-a", Head: "a", Pos: []string{"a"}},
		{ID: "loop-b", Head: "b", Pos: []string{"b"}},
	}
	res := assertScenario(t, "no circular derivation",
		[]string{"a", "b"}, rules,
		[]string{"a"}, []string{"b"}, nil)

	byHead := map[string]Derivation{}
	for _, d := range res.Rounds[0].KTrace.Derivations {
		byHead[d.Head] = d
	}
	if byHead["a"].RuleID != "fact-a" || len(byHead["a"].PremiseSeq) != 0 {
		t.Fatalf("fact must be the first trigger for a, got %+v", byHead["a"])
	}
	if _, ok := byHead["b"]; ok {
		t.Fatalf("unsupported cycle b <- b must never derive b")
	}
}

// Input slices and returned slices are independent; replacing a whole program
// leaves old results and the old snapshot unchanged.
func TestSnapshotImmutability(t *testing.T) {
	universe := []string{"a", "b"}
	rules := []Rule{
		{ID: "r1", Head: "a", Neg: []string{"b"}},
		{ID: "r2", Head: "b", Neg: []string{"a"}},
	}
	p := mustProgram(t, universe, rules)
	res := Evaluate(p)

	universe[0] = "tampered"
	rules[0].Head = "tampered"

	if got := p.Universe(); got[0] != "a" {
		t.Fatalf("program snapshot changed through input slice: %v", got)
	}
	if p.rules["r1"].head != "a" {
		t.Fatalf("rule snapshot changed through input slice")
	}
	res.True = append(res.True, "tampered")
	fresh := Evaluate(p)
	if len(fresh.True) != 0 || len(fresh.Unknown) != 2 {
		t.Fatalf("mutating a returned slice affected later evaluations")
	}
	rules2 := append(p.Rules(), Rule{ID: "fact-a", Head: "a"})
	p2 := mustProgram(t, p.Universe(), rules2)
	res2 := Evaluate(p2)
	if len(res2.True) != 1 || res2.True[0] != "a" || len(res2.False) != 1 || res2.False[0] != "b" {
		t.Fatalf("new snapshot with fact gave %+v", res2)
	}
	if len(res.Rounds) != 1 || len(res.Unknown) != 2 {
		t.Fatalf("old result changed after evaluating a replacement snapshot")
	}
}

// Invalid inputs are rejected rather than silently treated as false atoms.
func TestValidation(t *testing.T) {
	cases := []struct {
		name     string
		universe []string
		rules    []Rule
	}{
		{"duplicate atom", []string{"a", "a"}, nil},
		{"non-ascii atom", []string{"原子"}, nil},
		{"unknown head", []string{"a"}, []Rule{{ID: "r1", Head: "b"}}},
		{"unknown pos body", []string{"a"}, []Rule{{ID: "r1", Head: "a", Pos: []string{"b"}}}},
		{"unknown neg body", []string{"a"}, []Rule{{ID: "r1", Head: "a", Neg: []string{"b"}}}},
		{"duplicate rule id", []string{"a", "b"}, []Rule{
			{ID: "r", Head: "a"}, {ID: "r", Head: "b"},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewProgram(tc.universe, tc.rules); err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}
		})
	}
}
