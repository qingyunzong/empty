package permset

import (
	"errors"
	"math"
	"slices"
	"testing"
)

func evalOK(t *testing.T, expr string) []Interval {
	t.Helper()
	got, err := EvalExpr(expr)
	if err != nil {
		t.Fatalf("EvalExpr(%q): %v", expr, err)
	}
	return got
}

func TestParseUnionIntersectPrecedence(t *testing.T) {
	// & binds tighter than |
	got := evalOK(t, "[1,5] | [10,20] & [15,30]")
	want := []Interval{{1, 5}, {15, 20}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseDifferenceLeftAssoc(t *testing.T) {
	got := evalOK(t, "[1,10] - [3,4] - [6,6]")
	want := []Interval{{1, 2}, {5, 5}, {7, 10}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseParens(t *testing.T) {
	got := evalOK(t, "([1,5] | [10,20]) & [4,12]")
	want := []Interval{{4, 5}, {10, 12}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseNegativeAndExtremeBounds(t *testing.T) {
	got := evalOK(t, "[-9223372036854775808, -5] | [9223372036854775807, 9223372036854775807]")
	want := []Interval{{math.MinInt64, -5}, {math.MaxInt64, math.MaxInt64}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseWhitespace(t *testing.T) {
	got := evalOK(t, "  [ 1 , 5 ]\t|\n[ 6 , 9 ] ")
	want := []Interval{{1, 9}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func syntaxErrAt(t *testing.T, expr string, wantPos int) {
	t.Helper()
	_, err := EvalExpr(expr)
	var se *SyntaxError
	if !errors.As(err, &se) {
		t.Fatalf("EvalExpr(%q): got %v, want *SyntaxError", expr, err)
	}
	if se.Pos != wantPos {
		t.Fatalf("EvalExpr(%q): pos %d, want %d (err: %v)", expr, se.Pos, wantPos, err)
	}
}

func TestSyntaxErrorPositions(t *testing.T) {
	syntaxErrAt(t, "[1,]", 3)                     // ']' where integer expected
	syntaxErrAt(t, "[1,2", 4)                     // EOF where ']' expected
	syntaxErrAt(t, "[1 2]", 3)                    // '2' where ',' expected
	syntaxErrAt(t, "[1,2] [3,4]", 6)              // '[' after expression
	syntaxErrAt(t, "@abc", 0)                     // illegal character
	syntaxErrAt(t, "[1,2] &", 7)                  // EOF where factor expected
	syntaxErrAt(t, "([1,2]", 6)                   // EOF where ')' expected
	syntaxErrAt(t, "[5,1]", 0)                    // lo > hi reported at '['
	syntaxErrAt(t, "[9223372036854775808, 9]", 1) // literal overflow at digits
	syntaxErrAt(t, "[-9223372036854775809, 9]", 2)
	syntaxErrAt(t, "1foo", 0) // stray number
}

func TestUndefinedName(t *testing.T) {
	_, err := EvalExpr("nope | [1,2]")
	var ue *UndefinedError
	if !errors.As(err, &ue) || ue.Name != "nope" {
		t.Fatalf("got %v, want UndefinedError(nope)", err)
	}
}
