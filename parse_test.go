package permset

import (
	"errors"
	"math"
	"testing"
)

func TestEvalValidExpressions(t *testing.T) {
	full := Interval{math.MinInt64, math.MaxInt64}
	cases := []struct {
		src  string
		want Set
	}{
		{"[1,3] | [5,7]", Set{ivs: []Interval{{1, 3}, {5, 7}}}},
		{"[1,5] | [3,4]", Set{ivs: []Interval{{1, 5}}}},
		{"[1,2]|[3,4]", Set{ivs: []Interval{{1, 4}}}}, // adjacent merge
		{"([1,20] & [5,20]) - [8,9]", Set{ivs: []Interval{{5, 7}, {10, 20}}}},
		{"[1,2] | [3,4] & [4,5]", Set{ivs: []Interval{{1, 2}, {4, 4}}}}, // & binds tighter than |
		{"[1,10] - [2,3] - [5,6]", Set{ivs: []Interval{{1, 1}, {4, 4}, {7, 10}}}},
		{"[1,10] - [2,3] & [3,3]", Set{ivs: []Interval{{1, 2}, {4, 10}}}}, // & binds tighter than -
		{"[min,max]", Set{ivs: []Interval{full}}},
		{"[-9223372036854775808,9223372036854775807]", Set{ivs: []Interval{full}}},
		{"[0,max] | [min,-1]", Set{ivs: []Interval{full}}},
		{"[7]", Set{ivs: []Interval{{7, 7}}}},
		{"[ -5 , -1 ] & [min,0]", Set{ivs: []Interval{{-5, -1}}}},
		{"(([1,2]))", Set{ivs: []Interval{{1, 2}}}},
		{"[5,5] - [5,5]", Set{}},
	}
	for _, c := range cases {
		got, err := Eval(c.src)
		if err != nil {
			t.Fatalf("Eval(%q): unexpected error %v", c.src, err)
		}
		if !got.Equal(c.want) {
			t.Fatalf("Eval(%q) = %v, want %v", c.src, got, c.want)
		}
		checkCanonical(t, got)
	}
}

func TestParseErrorPositions(t *testing.T) {
	cases := []struct {
		src string
		pos int
	}{
		{"", 0},
		{"@", 0},
		{"1", 0},
		{"[1 2]", 3},
		{"[1,2", 4},
		{"[1,2]]", 5},
		{"[5,2]", 4},
		{"[1,2] |", 7},
		{"()", 1},
		{"[9223372036854775808]", 1},
		{"[-9223372036854775809]", 2},
		{"min", 0},
		{"[1,2] & [3,", 11},
		{"[1,2] -", 7},
		{"[a,2]", 1},
		{"[1,2] @ [3,4]", 6},
	}
	for _, c := range cases {
		_, err := Eval(c.src)
		if err == nil {
			t.Fatalf("Eval(%q): expected error, got none", c.src)
		}
		var perr *Error
		if !errors.As(err, &perr) {
			t.Fatalf("Eval(%q): error %v is not a *Error", c.src, err)
		}
		if perr.Pos != c.pos {
			t.Fatalf("Eval(%q): error position %d, want %d (msg: %s)", c.src, perr.Pos, c.pos, perr.Msg)
		}
	}
}

func TestEvalUndefinedName(t *testing.T) {
	_, err := Eval("alpha | [1,2]")
	var uerr *UndefinedError
	if !errors.As(err, &uerr) || uerr.Name != "alpha" {
		t.Fatalf("got %v, want UndefinedError for alpha", err)
	}
}

func TestParseRefsCollected(t *testing.T) {
	_, refs, err := parse("beta & [1,2] | alpha - beta")
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || refs[0] != "alpha" || refs[1] != "beta" {
		t.Fatalf("refs = %v, want [alpha beta]", refs)
	}
}
