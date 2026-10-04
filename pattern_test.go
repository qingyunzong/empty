package rulelib

import "testing"

func mustPattern(t *testing.T, glob string) Pattern {
	t.Helper()
	p, err := ParsePattern(glob)
	if err != nil {
		t.Fatalf("ParsePattern(%q): %v", glob, err)
	}
	return p
}

func TestDoubleStarCrossesZeroOrMoreSegments(t *testing.T) {
	p := mustPattern(t, "a/**")
	for _, path := range []string{"a", "a/b", "a/b/c"} {
		if !p.Match(splitPath(path)) {
			t.Errorf("a/** should match %q", path)
		}
	}
	for _, path := range []string{"", "b", "b/a"} {
		if p.Match(splitPath(path)) {
			t.Errorf("a/** should not match %q", path)
		}
	}
}

func TestStarMatchesExactlyOneSegment(t *testing.T) {
	p := mustPattern(t, "a/*/c")
	if !p.Match(splitPath("a/b/c")) {
		t.Error("a/*/c should match a/b/c")
	}
	for _, path := range []string{"a/c", "a/b/d/c", "a/b"} {
		if p.Match(splitPath(path)) {
			t.Errorf("a/*/c should not match %q", path)
		}
	}
}

func TestDoubleStarAloneMatchesEverything(t *testing.T) {
	p := mustPattern(t, "**")
	for _, path := range []string{"", "x", "x/y/z"} {
		if !p.Match(splitPath(path)) {
			t.Errorf("** should match %q", path)
		}
	}
}

func TestLiteralPattern(t *testing.T) {
	p := mustPattern(t, "a/b")
	if !p.Match(splitPath("a/b")) {
		t.Error("a/b should match a/b")
	}
	if p.Match(splitPath("a/b/c")) || p.Match(splitPath("a")) {
		t.Error("a/b should only match exactly a/b")
	}
}

func TestInvalidGlobs(t *testing.T) {
	for _, glob := range []string{"", "a//b", "a*b", "a/**b"} {
		if _, err := ParsePattern(glob); err == nil {
			t.Errorf("ParsePattern(%q) should fail", glob)
		}
	}
}

func TestRuleWithExclusions(t *testing.T) {
	r, err := NewRule("src", true, "src/** !src/internal/** !src/tmp")
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]bool{
		"src/main.go":    true,
		"src":            true,
		"src/internal/x": false,
		"src/internal":   false,
		"src/tmp":        false,
		"src/tmp/child":  true, // exclusion is the literal "src/tmp" only
		"other":          false,
	} {
		if got := r.matchesDirect(splitPath(path)); got != want {
			t.Errorf("matchesDirect(%q) = %v, want %v", path, got, want)
		}
	}
}
