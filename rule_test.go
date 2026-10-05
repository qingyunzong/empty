package main

import (
	"math/rand"
	"strings"
	"testing"
)

func allow(id, layer, lo, hi int) Rule { return Rule{ID: id, Layer: layer, Act: Allow, Lo: lo, Hi: hi} }
func deny(id, layer, lo, hi int) Rule  { return Rule{ID: id, Layer: layer, Act: Deny, Lo: lo, Hi: hi} }

func TestRejectedSemantics(t *testing.T) {
	cases := []struct {
		name  string
		rules []Rule
		q     int
		want  bool
	}{
		{"no rules default accept", nil, 5, false},
		{"no matching rule default accept", []Rule{allow(1, 0, 0, 3)}, 5, false},
		{"allow only accepts", []Rule{allow(1, 0, 0, 10)}, 5, false},
		{"deny without allow is moot", []Rule{deny(1, 0, 0, 10)}, 5, false},
		{"deny same layer revokes (deny-priority)", []Rule{allow(1, 0, 0, 10), deny(2, 0, 0, 10)}, 5, true},
		{"deny above allow revokes inherited grant", []Rule{allow(1, 0, 0, 10), deny(2, 3, 5, 5)}, 5, true},
		{"allow above deny re-grants", []Rule{deny(1, 0, 0, 10), allow(2, 2, 5, 5)}, 5, false},
		{"non-matching deny ignored", []Rule{allow(1, 0, 0, 10), deny(2, 9, 7, 8)}, 5, false},
		{"non-matching allow makes deny moot", []Rule{allow(1, 0, 7, 8), deny(2, 0, 0, 10)}, 5, false},
		{"interval boundaries inclusive", []Rule{allow(1, 0, 5, 5), deny(2, 0, 1, 5)}, 5, true},
		{"highest deny vs highest allow decides", []Rule{allow(1, 4, 0, 10), deny(2, 2, 0, 10), allow(3, 0, 0, 10)}, 5, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Rejected(tc.rules, tc.q); got != tc.want {
				t.Errorf("Rejected = %v, want %v", got, tc.want)
			}
			if got := RejectedIndependent(tc.rules, tc.q); got != tc.want {
				t.Errorf("RejectedIndependent = %v, want %v", got, tc.want)
			}
		})
	}
}

// The authoritative and independent evaluators must agree on every input.
func TestEvaluatorsAgreeFuzz(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 20000; trial++ {
		n := rng.Intn(7)
		rules := make([]Rule, n)
		for i := range rules {
			act := Allow
			if rng.Intn(2) == 0 {
				act = Deny
			}
			lo := rng.Intn(11) - 5
			rules[i] = Rule{ID: i + 1, Layer: rng.Intn(4), Act: act, Lo: lo, Hi: lo + rng.Intn(6)}
		}
		q := rng.Intn(11) - 5
		if Rejected(rules, q) != RejectedIndependent(rules, q) {
			t.Fatalf("evaluators disagree on rules=%v q=%d", rules, q)
		}
	}
}

func TestParseInput(t *testing.T) {
	rules, q, err := ParseInput(strings.NewReader("2 7\n10 0 allow 1 10\n11 1 deny 5 9\n"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if q != 7 || len(rules) != 2 || rules[0].ID != 10 || rules[1].Act != Deny || rules[1].Hi != 9 {
		t.Fatalf("bad parse: rules=%v q=%d", rules, q)
	}
}

func TestParseInputErrors(t *testing.T) {
	cases := map[string]string{
		"too many rules":      "19 0\n" + strings.Repeat("1 0 allow 0 1\n", 19),
		"negative count":      "-1 0\n",
		"duplicate id":        "2 0\n1 0 allow 0 1\n1 0 deny 0 1\n",
		"bad action":          "1 0\n1 0 block 0 1\n",
		"empty interval":      "1 0\n1 0 allow 5 4\n",
		"negative layer":      "1 0\n1 -1 allow 0 1\n",
		"truncated":           "2 0\n1 0 allow 0 1\n",
		"non-integer":         "x 0\n",
		"non-integer in rule": "1 0\nz 0 allow 0 1\n",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ParseInput(strings.NewReader(in)); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}
