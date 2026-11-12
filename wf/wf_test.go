package wf

import (
	"reflect"
	"sort"
	"testing"
)

func mustProgram(t *testing.T, universe []string, rules []Rule) *Program {
	t.Helper()
	p, err := NewProgram(universe, rules)
	if err != nil {
		t.Fatalf("NewProgram failed: %v", err)
	}
	return p
}

func assertValuation(t *testing.T, label string, res *Result, wantTrue, wantFalse, wantUnknown []string) {
	t.Helper()
	gotTrue, gotFalse, gotUnknown := sortedCopy(res.True), sortedCopy(res.False), sortedCopy(res.Unknown)
	wantTrue, wantFalse, wantUnknown = sortedCopy(wantTrue), sortedCopy(wantFalse), sortedCopy(wantUnknown)
	if !reflect.DeepEqual(gotTrue, wantTrue) {
		t.Errorf("%s: true = %v, want %v", label, res.True, wantTrue)
	}
	if !reflect.DeepEqual(gotFalse, wantFalse) {
		t.Errorf("%s: false = %v, want %v", label, res.False, wantFalse)
	}
	if !reflect.DeepEqual(gotUnknown, wantUnknown) {
		t.Errorf("%s: unknown = %v, want %v", label, res.Unknown, wantUnknown)
	}
}

func assertReferenceMatches(t *testing.T, label string, p *Program, res *Result) {
	t.Helper()
	ref := referenceEvaluate(p)
	if !reflect.DeepEqual(sortedCopy(ref.True), sortedCopy(res.True)) ||
		!reflect.DeepEqual(sortedCopy(ref.False), sortedCopy(res.False)) ||
		!reflect.DeepEqual(sortedCopy(ref.Unknown), sortedCopy(res.Unknown)) {
		t.Errorf("%s: reference %+v does not match alternating result T=%v F=%v U=%v",
			label, ref, res.True, res.False, res.Unknown)
	}
}

func assertRoundInvariants(t *testing.T, label string, p *Program, res *Result) {
	t.Helper()
	universe := p.Universe()
	var prevK, prevU []string
	for i, rd := range res.Rounds {
		if (len(rd.K) > 0 && !sort.StringsAreSorted(rd.K)) ||
			(len(rd.U) > 0 && !sort.StringsAreSorted(rd.U)) {
			t.Fatalf("%s round %d: K/U must be sorted", label, i+1)
		}
		if !isSubset(rd.K, rd.U) {
			t.Fatalf("%s round %d: K %v is not a subset of U %v", label, i+1, rd.K, rd.U)
		}
		if !isSubset(rd.U, universe) {
			t.Fatalf("%s round %d: U escapes universe", label, i+1)
		}
		if i > 0 {
			if !isSubset(prevK, rd.K) {
				t.Fatalf("%s round %d: K is not monotone increasing", label, i+1)
			}
			if !isSubset(rd.U, prevU) {
				t.Fatalf("%s round %d: U is not monotone decreasing", label, i+1)
			}
		}
		assertGammaConsistency(t, label, rd.KTrace, rd.Index, "K")
		assertGammaConsistency(t, label, rd.UTrace, rd.Index, "U")
		prevK, prevU = rd.K, rd.U
	}
	last := res.Rounds[len(res.Rounds)-1]
	if !reflect.DeepEqual(last.K, res.True) {
		t.Fatalf("%s: final K %v != true %v", label, last.K, res.True)
	}
	union := append(append([]string{}, res.True...), res.False...)
	union = append(union, res.Unknown...)
	if !reflect.DeepEqual(sortedCopy(union), universe) {
		t.Fatalf("%s: true/false/unknown do not partition B", label)
	}
}

func assertGammaConsistency(t *testing.T, label string, tr GammaTrace, round int, side string) {
	t.Helper()
	if len(tr.Closure) > 0 && !reflect.DeepEqual(sortedCopy(tr.Closure), tr.Closure) {
		t.Fatalf("%s round %d %s: closure not sorted", label, round, side)
	}
	if len(tr.S) > 0 && !sort.StringsAreSorted(tr.S) {
		t.Fatalf("%s round %d %s: Gamma S snapshot not sorted", label, round, side)
	}
	derived := make(map[string]bool)
	for _, d := range tr.Derivations {
		if derived[d.Head] {
			t.Fatalf("%s round %d %s: duplicate derivation for %s", label, round, side, d.Head)
		}
		derived[d.Head] = true
	}
	if len(derived) != len(tr.Closure) {
		t.Fatalf("%s round %d %s: derivations/closure mismatch", label, round, side)
	}
	prevSeq := 0
	if len(tr.Derivations) == 0 {
		// An empty closure is a legal Gamma result.
		return
	}
	seqOf := map[string]int{}
	for _, d := range tr.Derivations {
		if d.Seq != prevSeq+1 {
			t.Fatalf("%s round %d %s: derivation seqs must be contiguous from 1", label, round, side)
		}
		prevSeq = d.Seq
		seqOf[d.Head] = d.Seq
		for premise, seq := range d.PremiseSeq {
			if seq >= d.Seq || seq <= 0 {
				t.Fatalf("%s round %d %s: premise %s seq %d must precede head seq %d",
					label, round, side, premise, seq, d.Seq)
			}
			if seqOf[premise] != seq {
				t.Fatalf("%s round %d %s: premise seq mismatch for %s", label, round, side, premise)
			}
		}
	}
	inS := toSet(tr.S)
	removed := map[string]bool{}
	for _, rm := range tr.Removals {
		if !inS[rm.Atom] {
			t.Fatalf("%s round %d %s: removal reason %s not in input S", label, round, side, rm.Atom)
		}
		removed[rm.RuleID] = true
	}
	for _, er := range tr.Erasures {
		if removed[er.RuleID] {
			t.Fatalf("%s round %d %s: erased rule %s was also removed", label, round, side, er.RuleID)
		}
		if inS[er.Atom] {
			t.Fatalf("%s round %d %s: erased negative atom %s lies in S and should have removed the rule",
				label, round, side, er.Atom)
		}
	}
}

func assertFalseSupports(t *testing.T, label string, p *Program, res *Result) {
	t.Helper()
	trueSet := toSet(res.True)
	falseSet := toSet(res.False)
	if len(res.FalseSupports) != len(res.False) {
		t.Fatalf("%s: false support count mismatch", label)
	}
	rulesByHead := map[string][]Rule{}
	for _, rule := range p.Rules() {
		rulesByHead[rule.Head] = append(rulesByHead[rule.Head], rule)
	}
	for _, support := range res.FalseSupports {
		if !falseSet[support.Head] {
			t.Fatalf("%s: support for non-false atom %s", label, support.Head)
		}
		originalRules := rulesByHead[support.Head]
		if len(originalRules) == 0 {
			if !support.NoRules || len(support.Witnesses) != 0 {
				t.Fatalf("%s: atom %s without rules must be marked NoRules", label, support.Head)
			}
			continue
		}
		if support.NoRules {
			t.Fatalf("%s: atom %s has rules but marked NoRules", label, support.Head)
		}
		witnessed := map[string]bool{}
		for _, w := range support.Witnesses {
			switch w.Kind {
			case "pos_false":
				if !falseSet[w.Atom] {
					t.Fatalf("%s: pos_false witness %s is not false", label, w.Atom)
				}
			case "neg_true":
				if !trueSet[w.Atom] {
					t.Fatalf("%s: neg_true witness %s is not true", label, w.Atom)
				}
			default:
				t.Fatalf("%s: unknown witness kind %s", label, w.Kind)
			}
			witnessed[w.RuleID] = true
		}
		for _, rule := range originalRules {
			if !witnessed[rule.ID] {
				t.Fatalf("%s: false atom %s rule %s has no closed-support witness",
					label, support.Head, rule.ID)
			}
		}
	}
}

func assertScenario(t *testing.T, label string, universe []string, rules []Rule, wantTrue, wantFalse, wantUnknown []string) *Result {
	t.Helper()
	p := mustProgram(t, universe, rules)
	res := Evaluate(p)
	assertValuation(t, label, res, wantTrue, wantFalse, wantUnknown)
	assertReferenceMatches(t, label, p, res)
	assertRoundInvariants(t, label, p, res)
	assertFalseSupports(t, label, p, res)
	return res
}

func isSubset(small, big []string) bool {
	b := toSet(big)
	for _, x := range small {
		if !b[x] {
			return false
		}
	}
	return true
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}
