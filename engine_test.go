package rulelib

import (
	"errors"
	"testing"
)

func mustRule(t *testing.T, name string, allow bool, glob string) Rule {
	t.Helper()
	r, err := NewRule(name, allow, glob)
	if err != nil {
		t.Fatalf("NewRule(%q): %v", name, err)
	}
	return r
}

func TestPriorityBySpecificity(t *testing.T) {
	rules := []Rule{
		mustRule(t, "broad", true, "a/**"),
		mustRule(t, "exact", false, "a/b"),
		mustRule(t, "deeper", false, "a/**/secret"),
	}
	e, err := NewEngine(rules)
	if err != nil {
		t.Fatal(err)
	}
	// "a/b": exact (2 literals) beats deeper (1 literal) beats broad.
	res, err := e.Match("a/b")
	if err != nil || res.Decision != Deny || res.Rule != "exact" {
		t.Errorf("a/b: got %v %q %v, want deny/exact", res.Decision, res.Rule, err)
	}
	// "a/x/secret": deeper (1 literal, 3 segments) beats broad (1, 2).
	res, err = e.Match("a/x/secret")
	if err != nil || res.Decision != Deny || res.Rule != "deeper" {
		t.Errorf("a/x/secret: got %v %q %v, want deny/deeper", res.Decision, res.Rule, err)
	}
	// "a/x": only broad matches.
	res, err = e.Match("a/x")
	if err != nil || res.Decision != Allow || res.Rule != "broad" {
		t.Errorf("a/x: got %v %q %v, want allow/broad", res.Decision, res.Rule, err)
	}
	// No match: default deny, no rule.
	res, err = e.Match("z")
	if err != nil || res.Decision != Deny || res.Rule != "" {
		t.Errorf("z: got %v %q %v, want deny/", res.Decision, res.Rule, err)
	}
}

func TestTiedSpecificityRejected(t *testing.T) {
	rules := []Rule{
		mustRule(t, "r1", true, "a/*"),
		mustRule(t, "r2", false, "a/*"),
		mustRule(t, "r3", true, "b/*"),
	}
	e, err := NewEngine(rules)
	if err != nil {
		t.Fatal(err)
	}
	res, err := e.Match("a/x")
	if !errors.Is(err, ErrAmbiguous) {
		t.Errorf("a/x: want ErrAmbiguous, got %v", err)
	}
	if res.Decision != Deny {
		t.Errorf("a/x: ambiguous tie must be denied, got %v", res.Decision)
	}
	// Non-overlapping tied rules are fine.
	res, err = e.Match("b/y")
	if err != nil || res.Decision != Allow || res.Rule != "r3" {
		t.Errorf("b/y: got %v %q %v, want allow/r3", res.Decision, res.Rule, err)
	}
}

func TestHotReloadDoesNotReuseOldState(t *testing.T) {
	e, err := NewEngine([]Rule{mustRule(t, "allow-a", true, "a/**")})
	if err != nil {
		t.Fatal(err)
	}
	res, err := e.Match("a/b")
	if err != nil || res.Decision != Allow || res.Rule != "allow-a" {
		t.Fatalf("before reload: got %v %q %v", res.Decision, res.Rule, err)
	}
	gen := e.Generation()

	// Hot reload: flip the decision for the very same path.
	if err := e.Update([]Rule{mustRule(t, "deny-a", false, "a/**")}); err != nil {
		t.Fatal(err)
	}
	if e.Generation() == gen {
		t.Error("generation must bump on Update")
	}
	res, err = e.Match("a/b")
	if err != nil || res.Decision != Deny || res.Rule != "deny-a" {
		t.Errorf("after reload: got %v %q %v, want deny/deny-a (stale cache/automaton reused?)",
			res.Decision, res.Rule, err)
	}

	// Hot reload again: drop all rules; previously cached path must deny.
	if err := e.Update(nil); err != nil {
		t.Fatal(err)
	}
	res, err = e.Match("a/b")
	if err != nil || res.Decision != Deny || res.Rule != "" {
		t.Errorf("after dropping rules: got %v %q %v, want deny/", res.Decision, res.Rule, err)
	}
}

func TestVerifyCrossChecksCachedEngine(t *testing.T) {
	rules := []Rule{
		mustRule(t, "all", true, "**"),
		mustRule(t, "no-secret", false, "**/secret"),
		mustRule(t, "no-internal", false, "a/internal/**"),
		mustRule(t, "tmp-except", true, "tmp/** !tmp/lock"),
	}
	e, err := NewEngine(rules)
	if err != nil {
		t.Fatal(err)
	}
	n, err := Verify(e, rules, []string{"a", "tmp", "secret", "internal", "lock", "z"}, 3)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("verified %d paths", n)

	// Verify again after a hot reload: the fresh automaton and cache must
	// also agree with the uncached reference matcher.
	rules2 := []Rule{
		mustRule(t, "all", true, "**"),
		mustRule(t, "no-a", false, "a/**"),
		mustRule(t, "a-b-ok", true, "a/b !a/b/c"),
	}
	if err := e.Update(rules2); err != nil {
		t.Fatal(err)
	}
	n, err = Verify(e, rules2, []string{"a", "b", "c", "z"}, 3)
	if err != nil {
		t.Fatalf("verify after reload: %v", err)
	}
	t.Logf("verified %d paths after reload", n)
}
