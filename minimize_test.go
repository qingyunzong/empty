package main

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func TestMinSubsetKnownAnswer(t *testing.T) {
	rules := []Rule{
		{ID: "a", Layer: 0, Act: Deny, Lo: 0, Hi: 4},
		{ID: "b", Layer: 1, Act: Allow, Lo: 0, Hi: 10},
		{ID: "c", Layer: 2, Act: Deny, Lo: 5, Hi: 5},
		{ID: "d", Layer: 0, Act: Allow, Lo: 0, Hi: 10},
	}
	sub, ok := MinSubset(rules, 5)
	if !ok {
		t.Fatal("expected a denying subset")
	}
	if got := ruleIDs(sub); !reflect.DeepEqual(got, []string{"c"}) {
		t.Fatalf("got %v, want [c]", got)
	}
	sub, ok = MinSubset(rules, 3)
	if !ok {
		t.Fatal("expected a denying subset")
	}
	if got := ruleIDs(sub); !reflect.DeepEqual(got, []string{"a"}) {
		t.Fatalf("got %v, want [a]", got)
	}
}

func TestMinSubsetTieBreakByID(t *testing.T) {
	// Three equivalent single-rule proofs; the smallest ID must win.
	rules := []Rule{
		{ID: "z", Layer: 0, Act: Deny, Lo: 0, Hi: 9},
		{ID: "m", Layer: 0, Act: Deny, Lo: 0, Hi: 9},
		{ID: "a", Layer: 0, Act: Deny, Lo: 0, Hi: 9},
	}
	sub, ok := MinSubset(rules, 4)
	if !ok {
		t.Fatal("expected a denying subset")
	}
	if got := ruleIDs(sub); !reflect.DeepEqual(got, []string{"a"}) {
		t.Fatalf("got %v, want [a]", got)
	}
	// A higher-layer deny alone decides; single {m} must be found.
	rules = []Rule{
		{ID: "z", Layer: 0, Act: Deny, Lo: 0, Hi: 9},
		{ID: "m", Layer: 1, Act: Deny, Lo: 0, Hi: 9},
		{ID: "a", Layer: 0, Act: Allow, Lo: 0, Hi: 9},
	}
	// Single {m} denies (layer 1 deny, no higher match). Expect [m].
	sub, ok = MinSubset(rules, 4)
	if !ok {
		t.Fatal("expected a denying subset")
	}
	if got := ruleIDs(sub); !reflect.DeepEqual(got, []string{"m"}) {
		t.Fatalf("got %v, want [m]", got)
	}
}

func TestMinSubsetNone(t *testing.T) {
	rules := []Rule{
		{ID: "a", Layer: 0, Act: Allow, Lo: 0, Hi: 9},
		{ID: "b", Layer: 1, Act: Allow, Lo: 0, Hi: 9},
	}
	if _, ok := MinSubset(rules, 4); ok {
		t.Fatal("no subset denies; expected ok=false")
	}
}

func TestCombinationsLexOrder(t *testing.T) {
	var got [][]int
	combinations(4, 2, func(c []int) bool {
		got = append(got, append([]int(nil), c...))
		return true
	})
	want := [][]int{{0, 1}, {0, 2}, {0, 3}, {1, 2}, {1, 3}, {2, 3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// Early stop.
	count := 0
	combinations(5, 2, func(c []int) bool {
		count++
		return count < 3
	})
	if count != 3 {
		t.Fatalf("early stop: visited %d, want 3", count)
	}
}

func TestVerifyMinimalRejectsViolations(t *testing.T) {
	rules := []Rule{
		{ID: "a", Layer: 0, Act: Deny, Lo: 0, Hi: 9},
		{ID: "b", Layer: 0, Act: Deny, Lo: 0, Hi: 9},
	}
	v := 4
	// Non-denying subset.
	if err := VerifyMinimal(rules, v, rules[:0]); err == nil {
		t.Fatal("empty subset does not deny; expected error")
	}
	// Not minimal: {a,b} denies but {a} is smaller.
	if err := VerifyMinimal(rules, v, rules); err == nil {
		t.Fatal("expected smaller-subset violation")
	}
	// Wrong tie-break: {b} denies but {a} precedes it in ID order.
	if err := VerifyMinimal(rules, v, rules[1:]); err == nil {
		t.Fatal("expected ID-order violation")
	}
	// Correct answer passes.
	if err := VerifyMinimal(rules, v, rules[:1]); err != nil {
		t.Fatalf("correct answer rejected: %v", err)
	}
}

// bruteForceBest is the independent reference: scan all 2^n subsets and
// keep the best by (size, lexicographic sorted-ID list).
func bruteForceBest(rules []Rule, v int) ([]string, bool) {
	sorted := sortByID(rules)
	n := len(sorted)
	var best []string
	found := false
	for mask := 0; mask < 1<<n; mask++ {
		var cand []Rule
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				cand = append(cand, sorted[i])
			}
		}
		if !Denies(cand, v) {
			continue
		}
		ids := ruleIDs(cand)
		if !found || len(ids) < len(best) ||
			(len(ids) == len(best) && idListLess(ids, best)) {
			best = ids
			found = true
		}
	}
	return best, found
}

// TestExhaustiveAcceptanceRandom cross-checks MinSubset against the
// independent brute-force reference on randomized instances, and
// requires VerifyMinimal to accept every answer.
func TestExhaustiveAcceptanceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 2000; trial++ {
		n := rng.Intn(11) // 0..10 rules
		rules := make([]Rule, n)
		for i := range rules {
			lo := rng.Intn(7) - 2
			act := Allow
			if rng.Intn(2) == 0 {
				act = Deny
			}
			rules[i] = Rule{
				ID:    fmt.Sprintf("r%02d", i),
				Layer: rng.Intn(4),
				Act:   act,
				Lo:    lo,
				Hi:    lo + rng.Intn(6),
			}
		}
		v := rng.Intn(7) - 2
		sub, ok := MinSubset(rules, v)
		wantIDs, wantOK := bruteForceBest(rules, v)
		if ok != wantOK {
			t.Fatalf("trial %d: ok=%v, brute force says %v (rules=%+v v=%d)",
				trial, ok, wantOK, rules, v)
		}
		if !ok {
			continue
		}
		if got := ruleIDs(sub); !reflect.DeepEqual(got, wantIDs) {
			t.Fatalf("trial %d: got %v, brute force wants %v (rules=%+v v=%d)",
				trial, got, wantIDs, rules, v)
		}
		if err := VerifyMinimal(rules, v, sub); err != nil {
			t.Fatalf("trial %d: verify failed: %v (rules=%+v v=%d)", trial, err, rules, v)
		}
	}
}

// TestExhaustiveSmallSpace enumerates every rule set of up to 3 rules
// over a tiny domain and every request value, checking MinSubset
// against the brute-force reference for all of them.
func TestExhaustiveSmallSpace(t *testing.T) {
	var pool []Rule
	intervals := [][2]int{{0, 0}, {0, 1}, {0, 2}, {1, 1}, {1, 2}, {2, 2}}
	for _, layer := range []int{0, 1} {
		for _, act := range []Action{Allow, Deny} {
			for _, iv := range intervals {
				pool = append(pool, Rule{Layer: layer, Act: act, Lo: iv[0], Hi: iv[1]})
			}
		}
	}
	checked := 0
	for n := 0; n <= 3; n++ {
		combinations(len(pool), n, func(comb []int) bool {
			rules := make([]Rule, n)
			for i, j := range comb {
				rules[i] = pool[j]
				rules[i].ID = fmt.Sprintf("r%d", i)
			}
			for v := 0; v <= 2; v++ {
				sub, ok := MinSubset(rules, v)
				wantIDs, wantOK := bruteForceBest(rules, v)
				if ok != wantOK {
					t.Fatalf("ok=%v, want %v (rules=%+v v=%d)", ok, wantOK, rules, v)
				}
				if ok {
					if got := ruleIDs(sub); !reflect.DeepEqual(got, wantIDs) {
						t.Fatalf("got %v, want %v (rules=%+v v=%d)", got, wantIDs, rules, v)
					}
					if err := VerifyMinimal(rules, v, sub); err != nil {
						t.Fatalf("verify failed: %v (rules=%+v v=%d)", err, rules, v)
					}
				}
				checked++
			}
			return true
		})
	}
	t.Logf("exhaustively checked %d (rule set, request) pairs", checked)
}

// TestMinSubsetMaxSize exercises the 18-rule limit end to end.
func TestMinSubsetMaxSize(t *testing.T) {
	var rules []Rule
	for i := 0; i < 18; i++ {
		rules = append(rules, Rule{
			ID:    fmt.Sprintf("r%02d", i),
			Layer: 0,
			Act:   Allow,
			Lo:    0, Hi: 100,
		})
	}
	rules[17] = Rule{ID: "r17", Layer: 1, Act: Deny, Lo: 50, Hi: 60}
	sub, ok := MinSubset(rules, 55)
	if !ok {
		t.Fatal("expected a denying subset")
	}
	if got := ruleIDs(sub); !reflect.DeepEqual(got, []string{"r17"}) {
		t.Fatalf("got %v, want [r17]", got)
	}
	if err := VerifyMinimal(rules, 55, sub); err != nil {
		t.Fatalf("verify failed: %v", err)
	}
}
