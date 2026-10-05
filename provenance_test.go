package provenance

import (
	"fmt"
	"math/bits"
	"sort"
	"strings"
	"testing"
)

func lit(rel string, args ...string) Literal { return Literal{Rel: rel, Args: args} }

func fact(rel string, args ...string) Fact { return Fact{Rel: rel, Args: args} }

// testProgram returns 20 base facts and a non-recursive rule set in which
// output tuples of "q" have alternative derivations (via path2 or via mix).
func testProgram() ([]Fact, []Rule) {
	facts := []Fact{
		fact("edge", "a", "b"), fact("edge", "b", "c"), fact("edge", "c", "d"), fact("edge", "a", "c"),
		fact("edge", "d", "e"), fact("edge", "b", "d"), fact("edge", "e", "f"), fact("edge", "c", "f"),
		fact("edge", "a", "a"), fact("edge", "f", "g"),
		fact("red", "a"), fact("red", "b"), fact("red", "c"), fact("red", "d"), fact("red", "x"),
		fact("blue", "b"), fact("blue", "c"), fact("blue", "e"), fact("blue", "f"), fact("blue", "x"),
	}
	rules := []Rule{
		{Head: lit("path", "?x", "?y"), Body: []Literal{lit("edge", "?x", "?y")}},
		{Head: lit("path2", "?x", "?z"), Body: []Literal{lit("path", "?x", "?y"), lit("path", "?y", "?z")}},
		{Head: lit("mix", "?x", "?y"), Body: []Literal{lit("red", "?x"), lit("edge", "?x", "?y"), lit("blue", "?y")}},
		{Head: lit("q", "?x", "?y"), Body: []Literal{lit("path2", "?x", "?y")}},
		{Head: lit("q", "?x", "?y"), Body: []Literal{lit("mix", "?x", "?y")}},
	}
	return facts, rules
}

// plainEvaluator is an independent naive evaluator (no provenance) used to
// cross-check the engine by brute-force subset enumeration.
type plainEvaluator struct {
	facts  []Fact
	byHead map[string][]Rule
	order  []string
}

func newPlainEvaluator(t *testing.T, facts []Fact, rules []Rule) *plainEvaluator {
	t.Helper()
	order, err := CheckNonRecursive(rules)
	if err != nil {
		t.Fatalf("CheckNonRecursive: %v", err)
	}
	byHead := map[string][]Rule{}
	for _, r := range rules {
		byHead[r.Head.Rel] = append(byHead[r.Head.Rel], r)
	}
	return &plainEvaluator{facts: facts, byHead: byHead, order: order}
}

// derive returns the set of tuples of queryRel derived from the facts
// selected by mask, using plain set semantics.
func (p *plainEvaluator) derive(mask uint64, queryRel string) map[string]Tuple {
	rels := map[string]map[string]Tuple{}
	add := func(rel string, tup Tuple) {
		m := rels[rel]
		if m == nil {
			m = map[string]Tuple{}
			rels[rel] = m
		}
		m[tupleKey(tup)] = tup
	}
	for i, f := range p.facts {
		if mask&(1<<uint(i)) != 0 {
			add(f.Rel, f.Args)
		}
	}
	for _, rel := range p.order {
		for _, rule := range p.byHead[rel] {
			var rec func(idx int, bind map[string]string)
			rec = func(idx int, bind map[string]string) {
				if idx == len(rule.Body) {
					tup := make(Tuple, len(rule.Head.Args))
					for i, a := range rule.Head.Args {
						if isVar(a) {
							tup[i] = bind[a]
						} else {
							tup[i] = a
						}
					}
					add(rel, tup)
					return
				}
				body := rule.Body[idx]
				for _, tup := range rels[body.Rel] {
					if nb, ok := matchLiteral(body, tup, bind); ok {
						rec(idx+1, nb)
					}
				}
			}
			rec(0, map[string]string{})
		}
	}
	return rels[queryRel]
}

// minimalMasks keeps exactly the subset-minimal masks of the input set.
func minimalMasks(masks map[uint64]bool) map[uint64]bool {
	list := make([]uint64, 0, len(masks))
	for m := range masks {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool {
		ci, cj := bits.OnesCount64(list[i]), bits.OnesCount64(list[j])
		if ci != cj {
			return ci < cj
		}
		return list[i] < list[j]
	})
	out := map[uint64]bool{}
	var kept []uint64
	for _, m := range list {
		superset := false
		for _, k := range kept {
			if k&m == k {
				superset = true
				break
			}
		}
		if !superset {
			kept = append(kept, m)
			out[m] = true
		}
	}
	return out
}

func witnessSet(ws []Witness) map[uint64]bool {
	out := make(map[uint64]bool, len(ws))
	for _, w := range ws {
		out[uint64(w)] = true
	}
	return out
}

func sameMaskSet(a, b map[uint64]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for m := range a {
		if !b[m] {
			return false
		}
	}
	return true
}

// TestMinimalWitnessesMatchSubsetEnumeration enumerates every subset of the
// 20 input facts, derives the query with an independent plain evaluator, and
// checks that the minimal subsets deriving each output tuple are exactly the
// minimal witnesses reported by the engine.
func TestMinimalWitnessesMatchSubsetEnumeration(t *testing.T) {
	facts, rules := testProgram()
	if len(facts) != 20 {
		t.Fatalf("test program must have exactly 20 facts, got %d", len(facts))
	}
	eng, err := New(facts, rules)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	res := eng.Query("q")
	plain := newPlainEvaluator(t, facts, rules)

	derived := map[string]map[uint64]bool{} // tuple key -> subsets deriving it
	n := uint(len(facts))
	for mask := uint64(1); mask < (uint64(1) << n); mask++ {
		for key := range plain.derive(mask, "q") {
			if derived[key] == nil {
				derived[key] = map[uint64]bool{}
			}
			derived[key][mask] = true
		}
	}

	got := res.Tuples()
	if len(got) != len(derived) {
		t.Fatalf("engine derived %d tuples, brute force derived %d", len(got), len(derived))
	}
	for _, tup := range got {
		key := tupleKey(tup)
		masks, ok := derived[key]
		if !ok {
			t.Fatalf("engine derived tuple %v that brute force did not", tup)
		}
		want := minimalMasks(masks)
		if gotW := witnessSet(res.Witnesses(tup)); !sameMaskSet(gotW, want) {
			t.Errorf("tuple %v: engine witnesses %v, brute-force minimal subsets %v",
				tup, sortedMasks(gotW), sortedMasks(want))
		}
	}
}

func sortedMasks(set map[uint64]bool) []string {
	out := make([]string, 0, len(set))
	for m := range set {
		out = append(out, fmt.Sprintf("%020b", m))
	}
	sort.Strings(out)
	return out
}

// TestDeleteFactRetractsOnlyContainingWitnesses checks, for every single
// fact deletion, that filtering witnesses through Without matches a fresh
// evaluation on the reduced fact set.
func TestDeleteFactRetractsOnlyContainingWitnesses(t *testing.T) {
	facts, rules := testProgram()
	eng, err := New(facts, rules)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	full := eng.Query("q")
	for i := range facts {
		sub := full.Without(i)
		reduced := make([]Fact, 0, len(facts)-1)
		reduced = append(reduced, facts[:i]...)
		reduced = append(reduced, facts[i+1:]...)
		eng2, err := New(reduced, rules)
		if err != nil {
			t.Fatalf("New without fact %d: %v", i, err)
		}
		want := eng2.Query("q")

		gotTups := sub.Tuples()
		wantTups := want.Tuples()
		if len(gotTups) != len(wantTups) {
			t.Fatalf("delete fact %d (%v): got %d tuples, fresh evaluation gives %d",
				i, facts[i], len(gotTups), len(wantTups))
		}
		for j, tup := range gotTups {
			if tupleKey(tup) != tupleKey(wantTups[j]) {
				t.Fatalf("delete fact %d: tuple mismatch %v vs %v", i, tup, wantTups[j])
			}
			// Remap fresh witnesses (indexes into reduced) back to the
			// original fact indexes.
			remapped := map[uint64]bool{}
			for _, w := range want.Witnesses(wantTups[j]) {
				m := uint64(w)
				low := m & ((uint64(1) << uint(i)) - 1)
				remapped[low|((m>>uint(i))<<uint(i+1))] = true
			}
			if gotW := witnessSet(sub.Witnesses(tup)); !sameMaskSet(gotW, remapped) {
				t.Errorf("delete fact %d, tuple %v: Without witnesses %v, fresh evaluation %v",
					i, tup, sortedMasks(gotW), sortedMasks(remapped))
			}
		}
	}
}

// TestAlternativeWitnessesSurviveDeletion is a focused check of the deletion
// semantics: only witnesses containing the deleted fact are retracted.
func TestAlternativeWitnessesSurviveDeletion(t *testing.T) {
	facts := []Fact{
		fact("r", "a"), // 0
		fact("s", "a"), // 1
		fact("t", "a"), // 2
	}
	rules := []Rule{
		{Head: lit("q", "?x"), Body: []Literal{lit("r", "?x"), lit("s", "?x")}},
		{Head: lit("q", "?x"), Body: []Literal{lit("t", "?x")}},
	}
	eng, err := New(facts, rules)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	full := eng.Query("q")
	qa := Tuple{"a"}
	if got := witnessSet(full.Witnesses(qa)); !sameMaskSet(got, map[uint64]bool{0b011: true, 0b100: true}) {
		t.Fatalf("witnesses of q(a) = %v, want {0,1} and {2}", sortedMasks(got))
	}
	// Deleting fact 2 retracts the {2} witness; the {0,1} alternative keeps q(a).
	if w := full.Without(2).Witnesses(qa); !sameMaskSet(witnessSet(w), map[uint64]bool{0b011: true}) {
		t.Errorf("after deleting fact 2: witnesses %v, want {0,1}", sortedMasks(witnessSet(w)))
	}
	// Deleting fact 0 retracts {0,1}; the {2} alternative keeps q(a).
	if w := full.Without(0).Witnesses(qa); !sameMaskSet(witnessSet(w), map[uint64]bool{0b100: true}) {
		t.Errorf("after deleting fact 0: witnesses %v, want {2}", sortedMasks(witnessSet(w)))
	}
	// Deleting facts 0 and 1 (chained) still leaves the {2} alternative.
	if w := full.Without(0).Without(1).Witnesses(qa); !sameMaskSet(witnessSet(w), map[uint64]bool{0b100: true}) {
		t.Errorf("after deleting facts 0 and 1: witnesses %v, want {2}", sortedMasks(witnessSet(w)))
	}
	// Deleting fact 2 and fact 0 retracts every witness: q(a) disappears.
	if got := full.Without(2).Without(0).Tuples(); len(got) != 0 {
		t.Errorf("after deleting facts 2 and 0: tuples %v remain, want none", got)
	}
}

// TestSupersetWitnessesRemoved checks that a witness strictly containing
// another witness of the same tuple is discarded.
func TestSupersetWitnessesRemoved(t *testing.T) {
	facts := []Fact{
		fact("p", "a"), // 0
		fact("q", "a"), // 1
	}
	rules := []Rule{
		{Head: lit("out", "?x"), Body: []Literal{lit("p", "?x")}},
		{Head: lit("out", "?x"), Body: []Literal{lit("p", "?x"), lit("q", "?x")}},
	}
	eng, err := New(facts, rules)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	got := eng.Query("out").Witnesses(Tuple{"a"})
	if !sameMaskSet(witnessSet(got), map[uint64]bool{0b01: true}) {
		t.Errorf("witnesses = %v, want only the minimal {0}", sortedMasks(witnessSet(got)))
	}
}

func TestRejectsRecursiveRules(t *testing.T) {
	rules := []Rule{
		{Head: lit("p", "?x"), Body: []Literal{lit("q", "?x")}},
		{Head: lit("q", "?x"), Body: []Literal{lit("p", "?x")}},
	}
	if _, err := New(nil, rules); err == nil || !strings.Contains(err.Error(), "recursive") {
		t.Errorf("expected recursion error, got %v", err)
	}
	selfLoop := []Rule{
		{Head: lit("p", "?x"), Body: []Literal{lit("p", "?x")}},
	}
	if _, err := New(nil, selfLoop); err == nil {
		t.Errorf("expected recursion error for self-loop, got nil")
	}
}

func TestRejectsTooManyFacts(t *testing.T) {
	facts := make([]Fact, MaxFacts+1)
	for i := range facts {
		facts[i] = Fact{Rel: "p", Args: []string{fmt.Sprint(i)}}
	}
	if _, err := New(facts, nil); err == nil {
		t.Errorf("expected error for %d facts, got nil", len(facts))
	}
}

func TestRejectsUnsafeHeadVariable(t *testing.T) {
	rules := []Rule{
		{Head: lit("p", "?y"), Body: []Literal{lit("q", "?x")}},
	}
	if _, err := New(nil, rules); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Errorf("expected unsafe-variable error, got %v", err)
	}
}
