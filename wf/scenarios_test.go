package wf

import (
	"reflect"
	"testing"
)

// a <- a with no fact: a is unsupported and therefore false.
func TestSelfLoopNoFactIsFalse(t *testing.T) {
	res := assertScenario(t, "self-loop",
		[]string{"a"},
		[]Rule{{ID: "r1", Head: "a", Pos: []string{"a"}}},
		nil, []string{"a"}, nil)

	support := res.FalseSupports[0]
	if !support.NoRules && len(support.Witnesses) != 1 {
		t.Fatalf("expected one witness, got %+v", support)
	}
	w := support.Witnesses[0]
	if w.Kind != "pos_false" || w.Atom != "a" || !w.InCycle {
		t.Fatalf("self-loop witness must be an in-cycle pos_false, got %+v", w)
	}
}

// a <- not a: no stable model exists, but well-founded semantics returns
// unknown instead of an input error.
func TestNegativeSelfLoopIsUnknown(t *testing.T) {
	res := assertScenario(t, "negative self-loop",
		[]string{"a"},
		[]Rule{{ID: "r1", Head: "a", Neg: []string{"a"}}},
		nil, nil, []string{"a"})
	if len(res.Rounds) != 1 {
		t.Fatalf("K and U settle together after one round, got %d rounds", len(res.Rounds))
	}
	// The K-side Gamma is invoked with U=B, so the rule is removed; the
	// U-side Gamma is invoked with the empty K, so the not literal is erased.
	if len(res.Rounds[0].KTrace.Removals) != 1 || len(res.Rounds[0].UTrace.Erasures) != 1 {
		t.Fatalf("negative evidence must point at the S passed to each Gamma, got %+v", res.Rounds[0])
	}
}

// Mutually negating rules are both unknown.
func TestMutualNegationIsUnknown(t *testing.T) {
	rules := []Rule{
		{ID: "r1", Head: "a", Neg: []string{"b"}},
		{ID: "r2", Head: "b", Neg: []string{"a"}},
	}
	assertScenario(t, "mutual negation",
		[]string{"a", "b"}, rules,
		nil, nil, []string{"a", "b"})
}

// An undefined atom makes its negation usable, so a rule depending on it can
// derive a true head.
func TestUndefinedAtomMakesNegationTrue(t *testing.T) {
	rules := []Rule{
		{ID: "r1", Head: "a", Neg: []string{"b"}},
	}
	res := assertScenario(t, "undefined negation",
		[]string{"a", "b"}, rules,
		[]string{"a"}, []string{"b"}, nil)
	support := res.FalseSupports[0]
	if support.Head != "b" || !support.NoRules {
		t.Fatalf("undefined b must be marked as having no rule, got %+v", support)
	}
}

// A negative cycle reaches an external head through a positive edge: the
// external head stays unknown while the unrelated side is false.
func TestNegativeCycleAffectsExternalHead(t *testing.T) {
	rules := []Rule{
		{ID: "r1", Head: "a", Neg: []string{"b"}},
		{ID: "r2", Head: "b", Neg: []string{"a"}},
		{ID: "r3", Head: "c", Pos: []string{"a"}},
	}
	assertScenario(t, "negative cycle with external head",
		[]string{"a", "b", "c"}, rules,
		nil, nil, []string{"a", "b", "c"})
}

// Positive and negative occurrences of the same atom in one body do not delete
// the rule automatically; its body can never be all true.
func TestSameAtomPositiveAndNegative(t *testing.T) {
	t.Run("only conflicting rule leaves head false", func(t *testing.T) {
		rules := []Rule{
			{ID: "r1", Head: "a", Pos: []string{"a"}, Neg: []string{"a"}},
		}
		p := mustProgram(t, []string{"a"}, rules)
		compiled := p.rules["r1"]
		if len(compiled.pos) != 1 || len(compiled.neg) != 1 {
			t.Fatalf("conflicting literals must both be retained, got %+v", compiled)
		}
		assertScenario(t, "conflicting body",
			[]string{"a"}, rules,
			nil, []string{"a"}, nil)
	})

	t.Run("fact still wins over conflicting rule", func(t *testing.T) {
		rules := []Rule{
			{ID: "r1", Head: "a", Pos: []string{"a"}, Neg: []string{"a"}},
			{ID: "r2", Head: "a"},
		}
		assertScenario(t, "conflicting body plus fact",
			[]string{"a"}, rules,
			[]string{"a"}, nil, nil)
	})

	t.Run("alternate rule can still derive the head", func(t *testing.T) {
		rules := []Rule{
			{ID: "r1", Head: "a", Pos: []string{"b"}, Neg: []string{"b"}},
			{ID: "r2", Head: "b"},
		}
		assertScenario(t, "alternate derivation",
			[]string{"a", "b"}, rules,
			[]string{"b"}, []string{"a"}, nil)
	})
}

// Repeated premises are normalized to a set and count only once.
func TestRepeatedPremises(t *testing.T) {
	rules := []Rule{
		{ID: "r1", Head: "b"},
		{ID: "r2", Head: "a", Pos: []string{"b", "b", "b"}},
	}
	res := assertScenario(t, "repeated premise",
		[]string{"a", "b"}, rules,
		[]string{"a", "b"}, nil, nil)
	var deriv Derivation
	for _, d := range res.Rounds[0].KTrace.Derivations {
		if d.Head == "a" {
			deriv = d
		}
	}
	if deriv.RuleID != "r2" || deriv.Seq != 2 || !reflect.DeepEqual(deriv.PremiseSeq, map[string]int{"b": 1}) {
		t.Fatalf("repeated premise must be counted once, got %+v", deriv)
	}
}

// Adding a fact resolves unknowns in both directions; removing it restores the
// original three-valued result on a fresh immutable snapshot.
func TestFactsChangeAndRestoreUnknown(t *testing.T) {
	base := []Rule{
		{ID: "r1", Head: "a", Neg: []string{"b"}},
		{ID: "r2", Head: "b", Neg: []string{"a"}},
	}
	universe := []string{"a", "b"}

	original := mustProgram(t, universe, base)
	originalRes := Evaluate(original)
	assertValuation(t, "original cycle", originalRes, nil, nil, []string{"a", "b"})

	withFactA := mustProgram(t, universe, append(append([]Rule{}, base...), Rule{ID: "fact-a", Head: "a"}))
	resA := Evaluate(withFactA)
	assertValuation(t, "fact a", resA, []string{"a"}, []string{"b"}, nil)

	withFactB := mustProgram(t, universe, append(append([]Rule{}, base...), Rule{ID: "fact-b", Head: "b"}))
	resB := Evaluate(withFactB)
	assertValuation(t, "fact b", resB, []string{"b"}, []string{"a"}, nil)

	restored := mustProgram(t, universe, base)
	restoredRes := Evaluate(restored)
	assertValuation(t, "restored cycle", restoredRes, nil, nil, []string{"a", "b"})

	if !reflect.DeepEqual(originalRes.True, restoredRes.True) ||
		!reflect.DeepEqual(originalRes.False, restoredRes.False) ||
		!reflect.DeepEqual(originalRes.Unknown, restoredRes.Unknown) ||
		len(originalRes.Rounds) != len(restoredRes.Rounds) {
		t.Fatal("removing the fact must restore the original valuation")
	}
}
