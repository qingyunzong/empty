package rulecheck

import "testing"

func mustParse(t *testing.T, pat string) glob {
	t.Helper()
	g, err := parseGlob(pat)
	if err != nil {
		t.Fatalf("parseGlob(%q): %v", pat, err)
	}
	return g
}

func TestParseErrors(t *testing.T) {
	for _, bad := range []string{"", "a//b", "/a", "a/", "ab*", "*a", "a/**b"} {
		if _, err := parseGlob(bad); err == nil {
			t.Errorf("parseGlob(%q): expected error, got nil", bad)
		}
	}
}

func TestGlobMatch(t *testing.T) {
	cases := []struct {
		pat  string
		path string
		want bool
	}{
		{"a/b/c", "a/b/c", true},
		{"a/b/c", "a/b", false},
		{"a/b/c", "a/b/c/d", false},
		{"a/*", "a/b", true},
		{"a/*", "a/b/c", false},
		{"a/*", "a", false},
		{"a/**", "a", true},   // ** crosses zero segments
		{"a/**", "a/b", true}, // ** crosses one segment
		{"a/**", "a/b/c", true},
		{"a/**", "b/a", false},
		{"a/**/b", "a/b", true},
		{"a/**/b", "a/x/b", true},
		{"a/**/b", "a/x/y/b", true},
		{"a/**/b", "a/x/y", false},
		{"**/c", "c", true},
		{"**/c", "a/c", true},
		{"**/c", "a/b/c", true},
		{"**/c", "a/b/d", false},
		{"**", "", true},
		{"**", "anything/at/all", true},
		{"*/**", "x", true},
		{"*/**", "", false},
		{"x/*/**", "x/y", true},
		{"x/*/**", "x/y/z/w", true},
		{"x/*/**", "x", false},
	}
	for _, c := range cases {
		segs, err := splitPath(c.path)
		if err != nil {
			t.Fatalf("splitPath(%q): %v", c.path, err)
		}
		if got := mustParse(t, c.pat).match(segs); got != c.want {
			t.Errorf("match(%q, %q) = %v, want %v", c.pat, c.path, got, c.want)
		}
	}
}

func TestSpecificityOrder(t *testing.T) {
	// More literal segments wins; then more total segments.
	chain := []string{"a/b/c", "a/*/c", "a/*", "*/**", "**"}
	for i := 0; i < len(chain)-1; i++ {
		hi := mustParse(t, chain[i]).specificity()
		lo := mustParse(t, chain[i+1]).specificity()
		if !hi.higher(lo) {
			t.Errorf("specificity(%q)=%+v should be higher than specificity(%q)=%+v",
				chain[i], hi, chain[i+1], lo)
		}
	}
	// a/*/** (1 literal, 3 total) beats a/* (1 literal, 2 total).
	if !mustParse(t, "a/*/**").specificity().higher(mustParse(t, "a/*").specificity()) {
		t.Errorf("total segment count should break literal-count ties")
	}
}

func TestSplitPath(t *testing.T) {
	if segs, err := splitPath(""); err != nil || len(segs) != 0 {
		t.Errorf("empty path: got %v, %v", segs, err)
	}
	for _, bad := range []string{"/", "a//b", "/a", "a/"} {
		if _, err := splitPath(bad); err == nil {
			t.Errorf("splitPath(%q): expected error", bad)
		}
	}
}
