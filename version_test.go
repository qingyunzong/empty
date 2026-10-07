package preimage

import (
	"reflect"
	"testing"
)

func baseMap(t *testing.T) Map {
	t.Helper()
	m, err := NewMap([]Piece{
		{Dom: Interval{Lo: -10, Hi: 0}, F: NewAffine(1, 0, 2)},
		{Dom: Interval{Lo: 0, Hi: 10}, F: NewAffine(-1, 0, 1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestStorePatchVersions(t *testing.T) {
	base := baseMap(t)
	s := NewStore(base)
	if s.Latest() != 1 {
		t.Fatalf("latest = %d, want 1", s.Latest())
	}

	// Replace the branch on [0, 10) with a constant-3 map.
	v2, err := s.Patch([]Piece{{Dom: Interval{Lo: 0, Hi: 10}, F: NewAffine(0, 3, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	if v2 != 2 || s.Latest() != 2 {
		t.Fatalf("patch committed version %d, want 2", v2)
	}

	old, ok := s.Get(1)
	if !ok {
		t.Fatal("version 1 lost")
	}
	if v, _ := old.Eval(5); v != -5 {
		t.Fatalf("version 1 mutated: Eval(5) = %d, want -5", v)
	}
	cur, _ := s.Get(2)
	if v, _ := cur.Eval(5); v != 3 {
		t.Fatalf("version 2: Eval(5) = %d, want 3", v)
	}
	// Untouched half keeps its branch.
	if v, _ := cur.Eval(-3); v != -2 {
		t.Fatalf("version 2: Eval(-3) = %d, want -2", v)
	}

	// Preimage queries are reproducible per version.
	// v1: floor(x/2) in {-5,-4} -> [-10,-6); -x in {-5,-4} -> [4,6).
	y := Interval{Lo: -5, Hi: -3}
	want := []Interval{{Lo: -10, Hi: -6}, {Lo: 4, Hi: 6}}
	if got := old.Preimage(y); !reflect.DeepEqual(got, want) {
		t.Fatalf("v1 preimage %v, want %v", got, want)
	}
	// v2: only the untouched left branch still maps into y.
	if got, want2 := cur.Preimage(y), want[:1]; !reflect.DeepEqual(got, want2) {
		t.Fatalf("v2 preimage %v, want %v", got, want2)
	}
}

func TestPatchSplitsExistingPieces(t *testing.T) {
	m, _ := NewMap([]Piece{{Dom: Interval{Lo: 0, Hi: 10}, F: NewAffine(1, 0, 1)}})
	next, err := Patch(m, []Piece{{Dom: Interval{Lo: 3, Hi: 6}, F: NewAffine(-1, 0, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	pieces := next.Pieces()
	if len(pieces) != 3 {
		t.Fatalf("got %d pieces, want 3: %v", len(pieces), pieces)
	}
	for x := int64(0); x < 10; x++ {
		want := x
		if x >= 3 && x < 6 {
			want = -x
		}
		if got, _ := next.Eval(x); got != want {
			t.Fatalf("Eval(%d) = %d, want %d", x, got, want)
		}
	}
	// Original untouched.
	if got, _ := m.Eval(4); got != 4 {
		t.Fatalf("original mutated: Eval(4) = %d", got)
	}
}

func TestPatchValidation(t *testing.T) {
	m := baseMap(t)
	if _, err := Patch(m, []Piece{{Dom: Interval{Lo: 0, Hi: 30}, F: NewAffine(1, 0, 1)}}); err == nil {
		t.Fatal("expected error for edit outside domain")
	}
	if _, err := Patch(m, []Piece{{Dom: Interval{Lo: 2, Hi: 2}, F: NewAffine(1, 0, 1)}}); err == nil {
		t.Fatal("expected error for empty edit domain")
	}
	overlap := []Piece{
		{Dom: Interval{Lo: 0, Hi: 5}, F: NewAffine(1, 0, 1)},
		{Dom: Interval{Lo: 4, Hi: 8}, F: NewAffine(1, 0, 1)},
	}
	if _, err := Patch(m, overlap); err == nil {
		t.Fatal("expected error for overlapping edits")
	}
	adjacent := []Piece{
		{Dom: Interval{Lo: 0, Hi: 4}, F: NewAffine(2, 0, 1)},
		{Dom: Interval{Lo: 4, Hi: 8}, F: NewAffine(3, 0, 1)},
	}
	if _, err := Patch(m, adjacent); err != nil {
		t.Fatalf("adjacent edits must be accepted: %v", err)
	}
}

func TestChainAcrossVersions(t *testing.T) {
	// A chain may pin different versions of the same store.
	s := NewStore(baseMap(t))
	if _, err := s.Patch([]Piece{{Dom: Interval{Lo: 0, Hi: 10}, F: NewAffine(1, 0, 3)}}); err != nil {
		t.Fatal(err)
	}
	v1, _ := s.Get(1)
	v2, _ := s.Get(2)
	y := Interval{Lo: -2, Hi: 0}
	got1, _, _ := PreimageChain([]Map{v1, v1}, y, 0)
	got2, _, _ := PreimageChain([]Map{v2, v2}, y, 0)
	if reflect.DeepEqual(got1, got2) {
		t.Fatalf("expected versioned chains to differ, both %v", got1)
	}
	if want := bruteChainPreimage([]Map{v2, v2}, y); !reflect.DeepEqual(Canonicalize(got2), want) {
		t.Fatalf("v2 chain %v, brute force %v", got2, want)
	}
}
