package geom_test

import (
	"reflect"
	"testing"

	"geom"
)

func P(x, y int64) geom.Point { return geom.Point{X: x, Y: y} }

func build(pts ...geom.Point) *geom.Snapshot {
	s := geom.New()
	for i, p := range pts {
		s = s.Add(int64(i+1), p)
	}
	return s
}

func signedArea2(poly []geom.Point) int64 {
	var sum int64
	for i := range poly {
		j := (i + 1) % len(poly)
		sum += poly[i].X*poly[j].Y - poly[j].X*poly[i].Y
	}
	return sum
}

func TestHullDegenerate(t *testing.T) {
	s := geom.New()
	if got := s.Hull(); len(got) != 0 {
		t.Fatalf("empty hull = %v", got)
	}
	if s.Area2() != 0 {
		t.Fatalf("empty area2 = %d", s.Area2())
	}

	s1 := build(P(3, 4))
	if got := s1.Hull(); !reflect.DeepEqual(got, []geom.Point{P(3, 4)}) {
		t.Fatalf("single hull = %v", got)
	}

	s2 := build(P(5, 5), P(1, 1))
	if got := s2.Hull(); !reflect.DeepEqual(got, []geom.Point{P(1, 1), P(5, 5)}) {
		t.Fatalf("two-point hull = %v", got)
	}
}

func TestHullAllCollinear(t *testing.T) {
	for _, pts := range [][]geom.Point{
		{P(0, 0), P(1, 0), P(2, 0), P(3, 0)},          // horizontal
		{P(2, 5), P(2, -1), P(2, 9)},                  // vertical
		{P(0, 0), P(2, 2), P(4, 4), P(-2, -2)},        // diagonal
		{P(7, 7), P(7, 7), P(1, 1), P(4, 4), P(1, 1)}, // duplicates
	} {
		got := build(pts...).Hull()
		if len(got) != 2 {
			t.Fatalf("collinear %v: hull = %v, want 2 endpoints", pts, got)
		}
		if got[0] == got[1] {
			t.Fatalf("collinear %v: degenerate endpoints %v", pts, got)
		}
	}
}

func TestHullDropsCollinearEdgePoints(t *testing.T) {
	s := build(
		P(0, 0), P(1, 0), P(2, 0), // bottom edge with midpoint
		P(2, 1), P(2, 2), // right edge with midpoint
		P(1, 2), P(0, 2), // top edge with midpoint
		P(0, 1), // left edge midpoint
		P(1, 1), // interior
	)
	want := []geom.Point{P(0, 0), P(2, 0), P(2, 2), P(0, 2)}
	if got := s.Hull(); !reflect.DeepEqual(got, want) {
		t.Fatalf("hull = %v, want %v", got, want)
	}
	if got := s.Area2(); got != 8 {
		t.Fatalf("area2 = %d, want 8", got)
	}
}

func TestHullCCWFromLexMin(t *testing.T) {
	s := build(P(0, 0), P(4, 0), P(4, 3), P(0, 3), P(2, 1))
	h := s.Hull()
	want := []geom.Point{P(0, 0), P(4, 0), P(4, 3), P(0, 3)}
	if !reflect.DeepEqual(h, want) {
		t.Fatalf("hull = %v, want %v", h, want)
	}
	if signedArea2(h) <= 0 {
		t.Fatalf("hull not counterclockwise: %v", h)
	}
	if got := s.Area2(); got != 24 {
		t.Fatalf("area2 = %d, want 24", got)
	}
}

func TestArea2Triangle(t *testing.T) {
	s := build(P(0, 0), P(4, 0), P(0, 3))
	if got := s.Area2(); got != 12 {
		t.Fatalf("area2 = %d, want 12", got)
	}
}

func TestDuplicateCoordinatesGroupedByID(t *testing.T) {
	s := geom.New().
		Add(1, P(1, 1)).Add(2, P(1, 1)).Add(3, P(1, 1)).
		Add(4, P(0, 0)).Add(5, P(2, 0)).Add(6, P(0, 2))

	// (1,1) lies on the edge (2,0)-(0,2): one geometric point, three IDs.
	if got := s.Group(P(1, 1)); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("group = %v", got)
	}
	wantHull := []geom.Point{P(0, 0), P(2, 0), P(0, 2)}
	if got := s.Hull(); !reflect.DeepEqual(got, wantHull) {
		t.Fatalf("hull = %v, want %v", got, wantHull)
	}
	if r, ok := s.Rank(2); !ok || r != 0 {
		t.Fatalf("rank(2) = %d,%v want 0,true (boundary of outer layer)", r, ok)
	}

	// Removing one ID keeps the shared coordinate alive.
	s2 := s.Remove(1)
	if got := s2.Group(P(1, 1)); !reflect.DeepEqual(got, []int64{2, 3}) {
		t.Fatalf("group after remove = %v", got)
	}
	if got := s2.Hull(); !reflect.DeepEqual(got, wantHull) {
		t.Fatalf("hull after remove = %v", got)
	}
	// Removing all three deletes the coordinate.
	s3 := s.Remove(1).Remove(2).Remove(3)
	if got := s3.Group(P(1, 1)); len(got) != 0 {
		t.Fatalf("group after full remove = %v", got)
	}
	if _, ok := s3.Rank(1); ok {
		t.Fatal("rank of removed id should be absent")
	}
}

func TestLayersGrid(t *testing.T) {
	s := geom.New()
	id := int64(0)
	for x := int64(0); x < 3; x++ {
		for y := int64(0); y < 3; y++ {
			id++
			s = s.Add(id, P(x, y))
		}
	}
	layers := s.Layers()
	want := [][]geom.Point{
		{P(0, 0), P(2, 0), P(2, 2), P(0, 2)},
		{P(1, 1)},
	}
	if !reflect.DeepEqual(layers, want) {
		t.Fatalf("layers = %v, want %v", layers, want)
	}
	if got := s.LayerAreas2(); !reflect.DeepEqual(got, []int64{8, 0}) {
		t.Fatalf("layer areas = %v, want [8 0]", got)
	}
	// Edge midpoints belong to the outer boundary, center to layer 1.
	if r, _ := s.Rank(2); r != 0 { // id 2 = (0,1), edge midpoint
		t.Fatalf("rank of edge midpoint = %d, want 0", r)
	}
	if r, _ := s.Rank(5); r != 1 { // id 5 = (1,1), center
		t.Fatalf("rank of center = %d, want 1", r)
	}
}

func TestInteriorCorrectionChangesAllLayers(t *testing.T) {
	// Nested triangles: outer, middle, inner point.
	s := geom.New().
		Add(1, P(0, 0)).Add(2, P(10, 0)).Add(3, P(0, 10)).
		Add(4, P(2, 2)).Add(5, P(6, 2)).Add(6, P(2, 6)).
		Add(7, P(3, 3))
	if got := len(s.Layers()); got != 3 {
		t.Fatalf("layers = %d, want 3", got)
	}
	if r, _ := s.Rank(7); r != 2 {
		t.Fatalf("rank(7) = %d, want 2", r)
	}
	// Correcting the inner point to the far outside rewrites every layer.
	s2 := s.Add(7, P(20, 20))
	wantHull := []geom.Point{P(0, 0), P(10, 0), P(20, 20), P(0, 10)}
	if got := s2.Hull(); !reflect.DeepEqual(got, wantHull) {
		t.Fatalf("hull = %v, want %v", got, wantHull)
	}
	if r, _ := s2.Rank(7); r != 0 {
		t.Fatalf("rank(7) after correction = %d, want 0", r)
	}
	if r, _ := s2.Rank(4); r != 1 { // (2,2) now on layer 1
		t.Fatalf("rank(4) after correction = %d, want 1", r)
	}
	// Original snapshot is untouched.
	if r, _ := s.Rank(7); r != 2 {
		t.Fatalf("original rank(7) mutated: %d", r)
	}
}

func TestSnapshotPersistenceAndBranching(t *testing.T) {
	s0 := geom.New()
	s1 := s0.Add(1, P(0, 0)).Add(2, P(4, 0)).Add(3, P(0, 4))
	s2 := s1.Add(4, P(4, 4))
	s3 := s2.Remove(2)         // branch: delete from s2
	s4 := s1.Add(5, P(-1, -1)) // branch: extend s1 independently

	if s0.Len() != 0 || s1.Len() != 3 || s2.Len() != 4 || s3.Len() != 3 || s4.Len() != 4 {
		t.Fatalf("lens: %d %d %d %d %d", s0.Len(), s1.Len(), s2.Len(), s3.Len(), s4.Len())
	}
	if got := s1.Hull(); !reflect.DeepEqual(got, []geom.Point{P(0, 0), P(4, 0), P(0, 4)}) {
		t.Fatalf("s1 hull mutated: %v", got)
	}
	if got := s2.Hull(); !reflect.DeepEqual(got, []geom.Point{P(0, 0), P(4, 0), P(4, 4), P(0, 4)}) {
		t.Fatalf("s2 hull = %v", got)
	}
	if got := s3.Hull(); !reflect.DeepEqual(got, []geom.Point{P(0, 0), P(4, 4), P(0, 4)}) {
		t.Fatalf("s3 hull = %v", got)
	}
	if got := s4.Hull(); !reflect.DeepEqual(got, []geom.Point{P(-1, -1), P(4, 0), P(0, 4)}) {
		t.Fatalf("s4 hull = %v", got)
	}
	if _, ok := s3.Get(2); ok {
		t.Fatal("s3 should not contain id 2")
	}
	if p, ok := s2.Get(2); !ok || p != P(4, 0) {
		t.Fatal("s2 lost id 2 after branching remove")
	}
}

func TestAddReplacesExistingID(t *testing.T) {
	s := geom.New().Add(1, P(0, 0)).Add(1, P(9, 9))
	if s.Len() != 1 {
		t.Fatalf("len = %d, want 1", s.Len())
	}
	if p, _ := s.Get(1); p != P(9, 9) {
		t.Fatalf("get(1) = %v", p)
	}
}
