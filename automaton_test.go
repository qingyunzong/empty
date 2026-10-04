package rulelib

import (
	"strings"
	"testing"
)

// enumeratePaths yields every path of length 0..maxLen over tokens.
func enumeratePaths(tokens []string, maxLen int) [][]string {
	var out [][]string
	var walk func(prefix []string)
	walk = func(prefix []string) {
		cp := make([]string, len(prefix))
		copy(cp, prefix)
		out = append(out, cp)
		if len(prefix) >= maxLen {
			return
		}
		for _, tok := range tokens {
			walk(append(prefix, tok))
		}
	}
	walk(nil)
	return out
}

// TestDFAMatchesDirectGlob cross-checks the compiled symbolic automaton of
// each rule against the direct glob matcher on all short paths.
func TestDFAMatchesDirectGlob(t *testing.T) {
	globs := []string{
		"a/**", "a/*/c", "**", "a/b", "*/x", "**/y/**", "a",
		"a/** !a/b", "a/** !a/**/c", "x/** !x/y !x/z/**",
	}
	var rules []Rule
	for i, g := range globs {
		r, err := NewRule(strings.Repeat("r", 1)+string(rune('A'+i)), true, g)
		if err != nil {
			t.Fatal(err)
		}
		rules = append(rules, r)
	}
	alpha, err := newAlphabet(rules)
	if err != nil {
		t.Fatal(err)
	}
	tokens := append(append([]string{}, alpha.literals...), "zz")
	for _, r := range rules {
		d := ruleLanguage(r, alpha)
		for _, path := range enumeratePaths(tokens, 3) {
			got := d.match(path)
			want := r.matchesDirect(path)
			if got != want {
				t.Errorf("rule %q path %q: automaton=%v direct=%v",
					r.Glob, strings.Join(path, "/"), got, want)
			}
		}
	}
}

func TestCheckEmptyWitnessAndCertificate(t *testing.T) {
	// Empty language: include "a" minus exclusion "a".
	r, err := NewRule("empty", true, "a !a")
	if err != nil {
		t.Fatal(err)
	}
	alpha, err := newAlphabet([]Rule{r})
	if err != nil {
		t.Fatal(err)
	}
	res := checkEmpty(ruleLanguage(r, alpha))
	if !res.Empty {
		t.Fatalf("expected empty language, got witness %v", res.Witness)
	}
	if len(res.Certificate) == 0 || !strings.Contains(res.Certificate[0], "empty-language certificate") {
		t.Errorf("missing certificate header: %v", res.Certificate)
	}
	joined := strings.Join(res.Certificate, "\n")
	if !strings.Contains(joined, "accept=false") {
		t.Errorf("certificate must list reachable states, none accepting:\n%s", joined)
	}

	// Non-empty language: shortest witness for "a/**" is ["a"].
	r2, err := NewRule("nonempty", true, "a/**")
	if err != nil {
		t.Fatal(err)
	}
	res2 := checkEmpty(ruleLanguage(r2, alpha))
	if res2.Empty {
		t.Fatal("expected non-empty language")
	}
	if len(res2.Witness) != 1 || res2.Witness[0] != "a" {
		t.Errorf("shortest witness for a/** = %v, want [a]", res2.Witness)
	}
}

func TestDifferenceAutomaton(t *testing.T) {
	r1, _ := NewRule("r1", true, "a/**")
	r2, _ := NewRule("r2", true, "a/b")
	rules := []Rule{r1, r2}
	alpha, err := newAlphabet(rules)
	if err != nil {
		t.Fatal(err)
	}
	diff := combine(ruleLanguage(r1, alpha), ruleLanguage(r2, alpha), andNot)
	for path, want := range map[string]bool{
		"a":     true,
		"a/c":   true,
		"a/b":   false,
		"a/b/c": true,
		"b":     false,
	} {
		if got := diff.match(splitPath(path)); got != want {
			t.Errorf("diff match %q = %v, want %v", path, got, want)
		}
	}
}
