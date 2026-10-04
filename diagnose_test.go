package rulelib

import (
	"strings"
	"testing"
)

func findDiag(t *testing.T, diags []Diagnosis, name string) Diagnosis {
	t.Helper()
	for _, d := range diags {
		if d.Rule == name {
			return d
		}
	}
	t.Fatalf("no diagnosis for rule %q", name)
	return Diagnosis{}
}

func TestDiagnoseFullyShadowedRule(t *testing.T) {
	rules := []Rule{
		mustRule(t, "shadow", false, "a/*/**"), // more total segments: higher priority
		mustRule(t, "victim", true, "a/*"),     // L(a/*) is a subset of L(a/*/**)
	}
	diags, err := Diagnose(rules)
	if err != nil {
		t.Fatal(err)
	}
	d := findDiag(t, diags, "victim")
	if d.Reachable {
		t.Fatalf("victim should be unreachable, witness=%v", d.Witness)
	}
	if len(d.Certificate) == 0 {
		t.Fatal("unreachable rule must carry a complete empty-language certificate")
	}
	joined := strings.Join(d.Certificate, "\n")
	if !strings.Contains(joined, "empty-language certificate") || !strings.Contains(joined, "accept=false") {
		t.Errorf("certificate incomplete:\n%s", joined)
	}
	if !findDiag(t, diags, "shadow").Reachable {
		t.Error("shadow rule itself must be reachable")
	}
}

func TestDiagnoseGivesShortestReachablePath(t *testing.T) {
	rules := []Rule{
		mustRule(t, "exact", false, "a/b"), // 2 literals: higher priority
		mustRule(t, "broad", true, "a/**"), // partially shadowed only
	}
	diags, err := Diagnose(rules)
	if err != nil {
		t.Fatal(err)
	}
	d := findDiag(t, diags, "broad")
	if !d.Reachable {
		t.Fatalf("broad should still be reachable, certificate:\n%s", strings.Join(d.Certificate, "\n"))
	}
	// Shortest path decided by broad and not by exact is "a".
	if len(d.Witness) != 1 || d.Witness[0] != "a" {
		t.Errorf("witness = %v, want [a]", d.Witness)
	}
	// The witness must actually be decided by broad at match time.
	e, err := NewEngine(rules)
	if err != nil {
		t.Fatal(err)
	}
	res, err := e.Match(strings.Join(d.Witness, "/"))
	if err != nil || res.Rule != "broad" {
		t.Errorf("witness path decided by %q (err %v), want broad", res.Rule, err)
	}
}

func TestDiagnoseEmptyLanguageFromExclusions(t *testing.T) {
	rules := []Rule{
		mustRule(t, "self-empty", true, "a/** !a/**"),
	}
	diags, err := Diagnose(rules)
	if err != nil {
		t.Fatal(err)
	}
	d := findDiag(t, diags, "self-empty")
	if d.Reachable {
		t.Error("rule whose exclusions cover its include must be unreachable")
	}
	if len(d.Certificate) == 0 {
		t.Error("expected empty-language certificate")
	}
}

func TestDiagnoseTiedRulesDoNotShadowEachOther(t *testing.T) {
	rules := []Rule{
		mustRule(t, "t1", true, "a/*"),
		mustRule(t, "t2", false, "a/*"), // tied with t1: rejected at match, not shadowed
		mustRule(t, "top", true, "a/b"), // higher priority, shadows nothing fully
	}
	diags, err := Diagnose(rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"t1", "t2"} {
		d := findDiag(t, diags, name)
		if !d.Reachable {
			t.Errorf("%s: tied rules must not shadow each other", name)
		}
		// Shortest unshadowed path for a/* minus {a/b} is a/<other>.
		if len(d.Witness) != 2 || d.Witness[0] != "a" {
			t.Errorf("%s: witness = %v, want [a <other>]", name, d.Witness)
		}
	}
}
