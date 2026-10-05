package main

import (
	"math/rand"
	"reflect"
	"testing"
)

func idsOf(rules []Rule) []int {
	ids := make([]int, len(rules))
	for i, r := range rules {
		ids[i] = r.ID
	}
	return ids
}

func TestSolveKnownCases(t *testing.T) {
	cases := []struct {
		name  string
		rules []Rule
		q     int
		want  []int // expected minimal proof IDs, nil if none
	}{
		{
			name:  "single allow+deny pair",
			rules: []Rule{allow(1, 0, 0, 10), deny(2, 1, 5, 5)},
			q:     5,
			want:  []int{1, 2},
		},
		{
			name: "tie broken by ID order",
			rules: []Rule{
				allow(10, 0, 1, 10), deny(11, 1, 5, 9),
				allow(12, 0, 3, 4), deny(13, 2, 7, 7),
			},
			q:    7,
			want: []int{10, 11},
		},
		{
			name: "non-matching rules never needed",
			rules: []Rule{
				allow(1, 0, 0, 10), deny(2, 0, 0, 10),
				allow(3, 5, 100, 200), deny(4, 9, 300, 400),
			},
			q:    5,
			want: []int{1, 2},
		},
		{
			name:  "no rejecting subset when full set accepts",
			rules: []Rule{allow(1, 0, 0, 10)},
			q:     5,
			want:  nil,
		},
		{
			name:  "deny alone cannot prove rejection",
			rules: []Rule{deny(1, 3, 0, 10)},
			q:     5,
			want:  nil,
		},
		{
			name: "smaller-ID deny wins tie among pairs",
			rules: []Rule{
				allow(5, 0, 0, 10), deny(2, 0, 0, 10), deny(3, 1, 0, 10),
			},
			q:    5,
			want: []int{2, 5},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Solve(tc.rules, tc.q)
			if tc.want == nil {
				if ok {
					t.Fatalf("expected no proof, got %v", idsOf(got))
				}
				return
			}
			if !ok {
				t.Fatal("expected a proof, got none")
			}
			if !reflect.DeepEqual(idsOf(got), tc.want) {
				t.Fatalf("got %v, want %v", idsOf(got), tc.want)
			}
			if !Rejected(got, tc.q) {
				t.Fatal("returned subset does not reject")
			}
		})
	}
}

// bruteForceBest is a third, naive implementation: generate every combination
// of every size via recursion and keep the best by (size, sorted IDs).
func bruteForceBest(rules []Rule, q int) []int {
	var best []int
	for size := 0; size <= len(rules); size++ {
		combine(len(rules), size, func(idx []int) {
			sub := make([]Rule, len(idx))
			for i, ix := range idx {
				sub[i] = rules[ix]
			}
			if !Rejected(sub, q) {
				return
			}
			if best == nil || lessByID(rules, idx, best) {
				best = append([]int(nil), idx...)
			}
		})
		if best != nil {
			return sortedIDs(rules, best)
		}
	}
	return nil
}

func TestSolveMatchesBruteForceFuzz(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 3000; trial++ {
		n := rng.Intn(9)
		rules := make([]Rule, n)
		for i := range rules {
			act := Allow
			if rng.Intn(2) == 0 {
				act = Deny
			}
			lo := rng.Intn(11) - 5
			rules[i] = Rule{ID: rng.Intn(100), Layer: rng.Intn(4), Act: act, Lo: lo, Hi: lo + rng.Intn(6)}
		}
		q := rng.Intn(11) - 5
		got, ok := Solve(rules, q)
		want := bruteForceBest(rules, q)
		if want == nil {
			if ok {
				t.Fatalf("rules=%v q=%d: Solve found %v, brute force found none", rules, q, idsOf(got))
			}
			continue
		}
		if !ok {
			t.Fatalf("rules=%v q=%d: Solve found none, brute force found %v", rules, q, want)
		}
		if !reflect.DeepEqual(idsOf(got), want) {
			t.Fatalf("rules=%v q=%d: Solve=%v brute=%v", rules, q, idsOf(got), want)
		}
	}
}

func TestVerifyMinimality(t *testing.T) {
	rules := []Rule{
		allow(10, 0, 1, 10), deny(11, 1, 5, 9),
		allow(12, 0, 3, 4), deny(13, 2, 7, 7),
	}
	// True claim: nothing smaller than 2 rejects.
	checked, ok := VerifyMinimality(rules, 7, 2)
	if !ok {
		t.Fatal("expected minimality of 2 to be confirmed")
	}
	// 1 empty subset + 4 singletons were checked.
	if checked != 5 {
		t.Fatalf("checked %d subsets, want 5", checked)
	}
	// False claim: size 3 is not minimal; a smaller rejecting subset exists.
	if _, ok := VerifyMinimality(rules, 7, 3); ok {
		t.Fatal("expected false minimality claim to be rejected")
	}
}

func TestSolveMaxSizeInput(t *testing.T) {
	// 18 rules: the exhaustive scan must stay fast and correct at the limit.
	rules := []Rule{allow(1, 0, 0, 100), deny(2, 0, 50, 60)}
	for i := 3; i <= 18; i++ {
		rules = append(rules, Rule{ID: i, Layer: i % 3, Act: Action(i % 2), Lo: 1000 + i, Hi: 2000 + i})
	}
	got, ok := Solve(rules, 55)
	if !ok {
		t.Fatal("expected a proof")
	}
	if want := []int{1, 2}; !reflect.DeepEqual(idsOf(got), want) {
		t.Fatalf("got %v, want %v", idsOf(got), want)
	}
	if _, ok := VerifyMinimality(rules, 55, len(got)); !ok {
		t.Fatal("independent minimality check failed")
	}
}
