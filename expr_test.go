package licchk

import (
	"reflect"
	"testing"
)

func TestParseExpr(t *testing.T) {
	cases := []struct {
		src  string
		want string
	}{
		{"MIT", "MIT"},
		{"MIT AND Apache-2.0", "(MIT AND Apache-2.0)"},
		{"MIT OR Apache-2.0", "(MIT OR Apache-2.0)"},
		// AND binds tighter than OR.
		{"MIT OR Apache-2.0 AND BSD-3-Clause", "(MIT OR (Apache-2.0 AND BSD-3-Clause))"},
		{"(MIT OR Apache-2.0) AND BSD-3-Clause", "((MIT OR Apache-2.0) AND BSD-3-Clause)"},
		{"mit or apache-2.0", "(mit OR apache-2.0)"},
		{"GPL-3.0-only OR GPL-3.0-or-later", "(GPL-3.0-only OR GPL-3.0-or-later)"},
		{"A AND B OR C AND D", "((A AND B) OR (C AND D))"},
		{"((MIT))", "MIT"},
	}
	for _, tc := range cases {
		e, err := ParseExpr(tc.src)
		if err != nil {
			t.Errorf("ParseExpr(%q) error: %v", tc.src, err)
			continue
		}
		if got := e.String(); got != tc.want {
			t.Errorf("ParseExpr(%q).String() = %q, want %q", tc.src, got, tc.want)
		}
	}
}

func TestParseExprErrors(t *testing.T) {
	for _, src := range []string{
		"", "MIT AND", "OR MIT", "(MIT", "MIT)", "MIT OR (AND BSD)", "MIT @ BSD", "AND",
	} {
		if _, err := ParseExpr(src); err == nil {
			t.Errorf("ParseExpr(%q) expected error, got nil", src)
		}
	}
}

func TestOptions(t *testing.T) {
	cases := []struct {
		src  string
		want []Option
	}{
		{"MIT", []Option{{"MIT"}}},
		{"MIT OR Apache-2.0", []Option{{"MIT"}, {"Apache-2.0"}}},
		{"MIT AND Apache-2.0", []Option{{"Apache-2.0", "MIT"}}},
		{"(MIT OR Apache-2.0) AND BSD-3-Clause", []Option{{"BSD-3-Clause", "MIT"}, {"Apache-2.0", "BSD-3-Clause"}}},
		{"(A OR B) AND (C OR D)", []Option{{"A", "C"}, {"A", "D"}, {"B", "C"}, {"B", "D"}}},
		// Duplicate branches collapse.
		{"MIT OR MIT", []Option{{"MIT"}}},
		{"(MIT AND MIT) OR MIT", []Option{{"MIT"}}},
	}
	for _, tc := range cases {
		e, err := ParseExpr(tc.src)
		if err != nil {
			t.Fatalf("ParseExpr(%q): %v", tc.src, err)
		}
		got := Options(e)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("Options(%q) = %v, want %v", tc.src, got, tc.want)
		}
	}
}
