package regex

import (
	"reflect"
	"testing"
)

type want struct {
	caps []int
	ok   bool
}

func runTable(t *testing.T, cases []struct {
	pat, s string
	want   want
}) {
	t.Helper()
	for _, c := range cases {
		re, err := Compile(c.pat)
		if err != nil {
			t.Errorf("Compile(%q): %v", c.pat, err)
			continue
		}
		caps, ok := re.Find(c.s)
		if ok != c.want.ok {
			t.Errorf("Find(%q, %q): ok=%v, want %v", c.pat, c.s, ok, c.want.ok)
			continue
		}
		if ok && !reflect.DeepEqual(caps, c.want.caps) {
			t.Errorf("Find(%q, %q): caps=%v, want %v", c.pat, c.s, caps, c.want.caps)
		}
	}
}

func TestLeftmostEarliest(t *testing.T) {
	runTable(t, []struct {
		pat, s string
		want   want
	}{
		{"b", "aab", want{[]int{2, 3}, true}},
		{"ab", "xabab", want{[]int{1, 3}, true}},
		{"z", "abc", want{nil, false}},
		{"", "abc", want{[]int{0, 0}, true}},
	})
}

func TestLongest(t *testing.T) {
	runTable(t, []struct {
		pat, s string
		want   want
	}{
		// longest beats alternation branch order
		{"a|ab", "ab", want{[]int{0, 2}, true}},
		{"a*", "aaa", want{[]int{0, 3}, true}},
		{"(a|ab)", "ab", want{[]int{0, 2, 0, 2}, true}},
		// a shorter match at an earlier offset beats a longer later one
		{"a|bb", "abb", want{[]int{0, 1}, true}},
	})
}

func TestTieBreakByBranchOrder(t *testing.T) {
	runTable(t, []struct {
		pat, s string
		want   want
	}{
		// same span [0,2): branch "ab" precedes "a"+"b"
		{"(ab|a)(b?)", "ab", want{[]int{0, 2, 0, 2, 2, 2}, true}},
		// reversed branch order flips the captures
		{"(a|ab)(b?)", "ab", want{[]int{0, 2, 0, 1, 1, 2}, true}},
		// classic POSIX example: (a,bcd,"") beats (ab,c,d) at [0,4)
		{"(a|ab)(c|bcd)(d*)", "abcd", want{[]int{0, 4, 0, 1, 1, 4, 4, 4}, true}},
	})
}

func TestCapturesLastIteration(t *testing.T) {
	runTable(t, []struct {
		pat, s string
		want   want
	}{
		// the last iteration of the loop owns the capture
		{"(a|b)*", "ab", want{[]int{0, 2, 1, 2}, true}},
		{"((a)b)*", "abab", want{[]int{0, 4, 2, 4, 2, 3}, true}},
		// group participates only in the first iteration: kept
		{"((a)|b)*", "ab", want{[]int{0, 2, 1, 2, 0, 1}, true}},
		// greedy loops prefer consuming
		{"(a*)(a*)", "aa", want{[]int{0, 2, 0, 2, 2, 2}, true}},
		{"a?a", "a", want{[]int{0, 1}, true}},
	})
}

func TestEmptyLoopIteration(t *testing.T) {
	runTable(t, []struct {
		pat, s string
		want   want
	}{
		// a * loop never performs an empty iteration: group stays unset
		{"(a?)*", "", want{[]int{0, 0, -1, -1}, true}},
		{"(a?)*", "a", want{[]int{0, 1, 0, 1}, true}},
		{"(a*)*", "aa", want{[]int{0, 2, 0, 2}, true}},
		{"(a*)*", "", want{[]int{0, 0, -1, -1}, true}},
	})
}

func TestGroupsAndEscapes(t *testing.T) {
	runTable(t, []struct {
		pat, s string
		want   want
	}{
		{"(a)(b)?", "a", want{[]int{0, 1, 0, 1, -1, -1}, true}},
		{"(a)(b)?", "ab", want{[]int{0, 2, 0, 1, 1, 2}, true}},
		{"a\\*b", "a*b", want{[]int{0, 3}, true}},
		{"a\\*b", "aaab", want{nil, false}},
		{"\\(a\\)", "(a)", want{[]int{0, 3}, true}},
		{"a|", "b", want{[]int{0, 0}, true}},
	})
}

func TestCompileErrors(t *testing.T) {
	for _, pat := range []string{"(", ")", "a)", "*a", "?a", "|a)", "a\\", "(a"} {
		if _, err := Compile(pat); err == nil {
			t.Errorf("Compile(%q): expected error", pat)
		}
	}
}
