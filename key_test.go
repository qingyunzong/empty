package dataeng

import (
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"strings"
	"testing"
)

func foldCollation() NamedCollation {
	return NamedCollation{
		SQLName: "NOCASE",
		Cmp: func(a, b string) int {
			return strings.Compare(strings.ToLower(a), strings.ToLower(b))
		},
	}
}

func TestCompareCompositeNullsAndCollation(t *testing.T) {
	cols := []KeyColumn{
		{Name: "a", Kind: KindInt},
		{Name: "b", Kind: KindString, Nulls: NullsFirst, Collation: foldCollation()},
	}
	rows := []Tuple{
		{1, "a"},
		{1, "B"},
		{1, nil},
		{2, nil},
		{nil, "a"},
		{1, "A"},
	}
	if err := SortTuples(rows, cols); err != nil {
		t.Fatal(err)
	}
	if got, want := FormatTuple(rows[0]), `(1, NULL)`; got != want {
		t.Fatalf("first = %s, want %s", got, want)
	}
	if got, want := FormatTuple(rows[len(rows)-1]), `(NULL, "a")`; got != want {
		t.Fatalf("last = %s, want %s", got, want)
	}
	if cmp, err := CompareTuples(rows[3], rows[4], cols); err != nil || cmp >= 0 {
		t.Fatalf("A/a should sort before B: cmp=%d err=%v", cmp, err)
	}
}

func TestDescendingStillHonorsExplicitNullOrder(t *testing.T) {
	rows := []Tuple{{2}, {nil}, {1}, {3}}
	cols := []KeyColumn{{Name: "id", Kind: KindInt, Desc: true, Nulls: NullsLast}}
	if err := SortTuples(rows, cols); err != nil {
		t.Fatal(err)
	}
	want := []string{"3", "2", "1", "NULL"}
	for i, w := range want {
		if got := FormatTuple(rows[i]); got != "("+w+")" {
			t.Fatalf("row %d = %s, want (%s)", i, got, w)
		}
	}

	cols[0].Nulls = NullsFirst
	if err := SortTuples(rows, cols); err != nil {
		t.Fatal(err)
	}
	if got := FormatTuple(rows[0]); got != "(NULL)" {
		t.Fatalf("NULLS FIRST row = %s", got)
	}
}

func TestNumericComparisonAcrossKinds(t *testing.T) {
	cases := []struct {
		a, b Value
		want int
	}{
		{int64(1), float64(1), 0},
		{uint64(math.MaxUint64), new(big.Int).SetUint64(math.MaxUint64), 0},
		{big.NewInt(10), 9.5, 1},
		{jsonNumber("1.000"), 1, 0},
	}
	for _, tc := range cases {
		got, err := CompareValues(tc.a, tc.b, KeyColumn{Name: "n", Kind: KindFloat})
		if err != nil {
			t.Fatalf("%v vs %v: %v", tc.a, tc.b, err)
		}
		if got != tc.want {
			t.Fatalf("%v vs %v = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestComparisonErrors(t *testing.T) {
	col := KeyColumn{Name: "k", Kind: KindAny}
	if _, err := CompareValues(math.NaN(), 1.0, col); !errors.Is(err, ErrNaN) {
		t.Fatalf("NaN error = %v", err)
	}
	if _, err := CompareValues("x", 1, col); !errors.Is(err, ErrIncomparable) {
		t.Fatalf("type error = %v", err)
	}
	if _, err := CompareTuples(Tuple{1}, Tuple{1, 2}, []KeyColumn{col, {Name: "k2"}}); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("length error = %v", err)
	}
}

func jsonNumber(s string) Value {
	return json.Number(s)
}
