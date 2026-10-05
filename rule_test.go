package main

import "testing"

func TestDeniesDefaultAllow(t *testing.T) {
	if Denies(nil, 5) {
		t.Fatal("empty rule set must not deny (default allow)")
	}
	rules := []Rule{{ID: "a", Layer: 0, Act: Deny, Lo: 1, Hi: 3}}
	if Denies(rules, 5) {
		t.Fatal("non-matching rule must not deny")
	}
}

func TestDeniesIntervalBoundariesInclusive(t *testing.T) {
	rules := []Rule{{ID: "a", Layer: 0, Act: Deny, Lo: 1, Hi: 3}}
	for _, v := range []int{1, 2, 3} {
		if !Denies(rules, v) {
			t.Fatalf("value %d inside [1,3] must be denied", v)
		}
	}
	for _, v := range []int{0, 4} {
		if Denies(rules, v) {
			t.Fatalf("value %d outside [1,3] must not be denied", v)
		}
	}
}

func TestDeniesDenyPrioritySameLayer(t *testing.T) {
	rules := []Rule{
		{ID: "allow", Layer: 2, Act: Allow, Lo: 0, Hi: 10},
		{ID: "deny", Layer: 2, Act: Deny, Lo: 0, Hi: 10},
	}
	if !Denies(rules, 5) {
		t.Fatal("deny must win over allow at the same deciding layer")
	}
}

func TestDeniesHigherLayerOverrides(t *testing.T) {
	rules := []Rule{
		{ID: "deny", Layer: 1, Act: Deny, Lo: 0, Hi: 10},
		{ID: "allow", Layer: 2, Act: Allow, Lo: 0, Hi: 10},
	}
	if Denies(rules, 5) {
		t.Fatal("higher-layer allow must override lower-layer deny")
	}
	rules = append(rules, Rule{ID: "deny2", Layer: 3, Act: Deny, Lo: 5, Hi: 5})
	if !Denies(rules, 5) {
		t.Fatal("highest-layer deny must decide")
	}
}

func TestDeniesLowerLayerDecidesWhenHigherDoesNotMatch(t *testing.T) {
	rules := []Rule{
		{ID: "deny", Layer: 1, Act: Deny, Lo: 0, Hi: 10},
		{ID: "allow", Layer: 2, Act: Allow, Lo: 7, Hi: 9},
	}
	if !Denies(rules, 5) {
		t.Fatal("non-matching higher layer must not affect the decision")
	}
	if Denies(rules, 8) {
		t.Fatal("matching higher-layer allow must override")
	}
}

func TestParseAction(t *testing.T) {
	if a, err := parseAction("allow"); err != nil || a != Allow {
		t.Fatalf("allow: got %v, %v", a, err)
	}
	if a, err := parseAction("deny"); err != nil || a != Deny {
		t.Fatalf("deny: got %v, %v", a, err)
	}
	if _, err := parseAction("block"); err == nil {
		t.Fatal("unknown action must be rejected")
	}
}
