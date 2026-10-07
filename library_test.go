package rulecheck

import (
	"strings"
	"testing"
)

// refDecision is the independent, cache-free, automaton-free reference: it
// matches each rule with the plain recursive glob matcher and picks the most
// specific matching rule.
func refDecision(t *testing.T, rules []Rule, segs []string) Decision {
	t.Helper()
	best := -1
	var bestSpec specificity
	for i, r := range rules {
		inc, err := parseGlob(r.Include)
		if err != nil {
			t.Fatalf("bad test rule %q: %v", r.ID, err)
		}
		if !inc.match(segs) {
			continue
		}
		excluded := false
		for _, ex := range r.Excludes {
			g, err := parseGlob(ex)
			if err != nil {
				t.Fatalf("bad test rule %q exclude: %v", r.ID, err)
			}
			if g.match(segs) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		spec := inc.specificity()
		if best < 0 || spec.higher(bestSpec) {
			if best >= 0 && !spec.higher(bestSpec) && !bestSpec.higher(spec) {
				t.Fatalf("reference: ambiguous tie at %v", segs)
			}
			best, bestSpec = i, spec
		}
	}
	if best < 0 {
		return Decision{}
	}
	return Decision{Matched: true, RuleID: rules[best].ID, Include: rules[best].Include}
}

// enumeratePaths returns every path of length 0..maxLen over the alphabet.
func enumeratePaths(alphabet []string, maxLen int) [][]string {
	out := [][]string{nil}
	cur := [][]string{nil}
	for l := 0; l < maxLen; l++ {
		var next [][]string
		for _, p := range cur {
			for _, s := range alphabet {
				np := append(append([]string{}, p...), s)
				out = append(out, np)
				next = append(next, np)
			}
		}
		cur = next
	}
	return out
}

func pathString(segs []string) string { return strings.Join(segs, "/") }

var enumRules = []Rule{
	{ID: "exact", Include: "a/b/c"},
	{ID: "mid", Include: "a/*/c"},
	{ID: "star", Include: "a/**", Excludes: []string{"a/tmp", "a/tmp/**"}},
	{ID: "deep", Include: "*/**/d"},
	{ID: "all", Include: "**"},
}

var enumAlphabet = []string{"a", "b", "c", "d", "tmp", "zz"}

func TestEnumerationCrossCheck(t *testing.T) {
	lib, err := NewLibrary(enumRules)
	if err != nil {
		t.Fatalf("NewLibrary: %v", err)
	}
	crossCheck(t, lib, lib.Matcher(), enumRules, enumAlphabet, 4)
}

func TestPriorityAndExclusions(t *testing.T) {
	lib, err := NewLibrary(enumRules)
	if err != nil {
		t.Fatalf("NewLibrary: %v", err)
	}
	m := lib.Matcher()
	cases := []struct {
		path, want string
	}{
		{"a/b/c", "exact"},
		{"a/x/c", "mid"},
		{"a/x/y", "star"},
		{"z/z/z/d", "deep"},
		{"q", "all"},
	}
	for _, c := range cases {
		d, err := m.Match(c.path)
		if err != nil {
			t.Fatalf("Match(%q): %v", c.path, err)
		}
		if d.RuleID != c.want {
			t.Errorf("Match(%q) = %q, want %q", c.path, d.RuleID, c.want)
		}
	}
	// Excluded paths fall through to less specific rules that still match.
	d, _ := m.Match("a/tmp")
	if d.RuleID != "all" {
		t.Errorf("a/tmp should fall through to rule all, got %q", d.RuleID)
	}
	d, _ = m.Match("a/tmp/x")
	if d.RuleID != "all" {
		t.Errorf("a/tmp/x should fall through to rule all, got %q", d.RuleID)
	}
}

func TestTieRejected(t *testing.T) {
	// Same specificity (1 literal, 2 total), overlapping on "a/b": reject.
	if _, err := NewLibrary([]Rule{
		{ID: "r1", Include: "a/*"},
		{ID: "r2", Include: "*/b"},
	}); err == nil {
		t.Fatal("expected ambiguity error for overlapping equal-specificity rules")
	}
	// Same specificity but disjoint languages: allowed.
	if _, err := NewLibrary([]Rule{
		{ID: "r1", Include: "a/*"},
		{ID: "r2", Include: "b/*"},
	}); err != nil {
		t.Fatalf("disjoint equal-specificity rules should be accepted: %v", err)
	}
	// Overlapping includes disambiguated by exclusions: allowed.
	if _, err := NewLibrary([]Rule{
		{ID: "r1", Include: "a/*", Excludes: []string{"a/b"}},
		{ID: "r2", Include: "*/b", Excludes: []string{"c/b"}},
	}); err != nil {
		t.Fatalf("exclusion-disambiguated rules should be accepted: %v", err)
	}
	if _, err := NewLibrary([]Rule{
		{ID: "r1", Include: "a"},
		{ID: "r1", Include: "b"},
	}); err == nil {
		t.Fatal("expected duplicate ID error")
	}
}

func TestHotReloadNoStaleState(t *testing.T) {
	lib1, err := NewLibrary(enumRules)
	if err != nil {
		t.Fatalf("NewLibrary lib1: %v", err)
	}
	m := lib1.Matcher()

	// Populate the cache with lib1 decisions.
	for _, segs := range enumeratePaths(enumAlphabet, 2) {
		if _, err := m.Match(pathString(segs)); err != nil {
			t.Fatal(err)
		}
	}
	if m.CacheSize() == 0 {
		t.Fatal("cache should be populated")
	}
	gen0 := m.Generation()

	rules2 := []Rule{
		{ID: "n1", Include: "a/**/x"},
		{ID: "n2", Include: "b"},
		{ID: "n3", Include: "**", Excludes: []string{"b/**"}},
	}
	lib2, err := NewLibrary(rules2)
	if err != nil {
		t.Fatalf("NewLibrary lib2: %v", err)
	}
	m.Reload(lib2)

	if m.Generation() == gen0 {
		t.Error("generation should increase after Reload")
	}
	if m.CacheSize() != 0 {
		t.Error("cache must be discarded on Reload, not reused")
	}

	// A path decided under lib1 must now reflect lib2, proving no stale
	// automaton or cache state survives the reload.
	d, err := m.Match("a/b/c")
	if err != nil {
		t.Fatal(err)
	}
	if d.RuleID != "n3" {
		t.Errorf("after reload a/b/c should hit n3, got %q", d.RuleID)
	}

	// Full small-path enumeration cross-check on the reloaded matcher.
	crossCheck(t, lib2, m, rules2, enumAlphabet, 3)
}

// crossCheck compares, for every enumerated path: cached matcher (queried
// twice to exercise the cache), uncached matcher, per-rule automata, and the
// independent reference.
func crossCheck(t *testing.T, lib *Library, m *Matcher, rules []Rule, alphabet []string, maxLen int) {
	t.Helper()
	for _, segs := range enumeratePaths(alphabet, maxLen) {
		p := pathString(segs)
		want := refDecision(t, rules, segs)
		got1, err := m.Match(p)
		if err != nil {
			t.Fatalf("Match(%q): %v", p, err)
		}
		got2, err := m.Match(p)
		if err != nil {
			t.Fatalf("Match(%q) cached: %v", p, err)
		}
		gotFresh, err := m.MatchNoCache(p)
		if err != nil {
			t.Fatalf("MatchNoCache(%q): %v", p, err)
		}
		if got1 != want || got2 != want || gotFresh != want {
			t.Errorf("path %q: cached=%+v cached2=%+v nocache=%+v, reference=%+v",
				p, got1, got2, gotFresh, want)
		}
		for _, r := range rules {
			autoSays := lib.Automaton(r.ID).Match(segs)
			refSays := refDecision(t, []Rule{r}, segs).Matched
			if autoSays != refSays {
				t.Errorf("path %q rule %q: automaton=%v reference=%v", p, r.ID, autoSays, refSays)
			}
		}
	}
}
