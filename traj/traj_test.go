package traj

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestLinkedBoundaries(t *testing.T) {
	const g, r2 = 10, 25 // r = 5
	base := Point{ID: 1, T: 100, X: 0, Y: 0}
	cases := []struct {
		name string
		p    Point
		want bool
	}{
		{"time gap equal to g", Point{ID: 2, T: 110, X: 0, Y: 0}, true},
		{"time gap above g", Point{ID: 2, T: 111, X: 0, Y: 0}, false},
		{"dist squared equal to r2 (3-4-5)", Point{ID: 2, T: 100, X: 3, Y: 4}, true},
		{"dist squared above r2", Point{ID: 2, T: 100, X: 3, Y: 5}, false},
		{"both limits exactly", Point{ID: 2, T: 90, X: -4, Y: 3}, true},
		{"both exceeded", Point{ID: 2, T: 111, X: 4, Y: 4}, false},
	}
	for _, c := range cases {
		if got := Linked(base, c.p, g, r2); got != c.want {
			t.Errorf("%s: Linked = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestCorrectionSplitsSegment(t *testing.T) {
	s := New(1, 100)
	for i := 0; i < 4; i++ {
		s.Upsert(Point{ID: i + 1, T: int64(i), X: 0, Y: 0})
	}
	if segs := s.Segments(); len(segs) != 1 || len(segs[0].Edges) != 3 {
		t.Fatalf("before correction: got %+v, want one segment with 3 edges", segs)
	}
	// Move point 2 far away: breaks edges 1-2 and 2-3, and 1-3 has dt=2 > g.
	s.Upsert(Point{ID: 2, T: 1, X: 1000, Y: 1000})
	segs := s.Segments()
	want := []Segment{
		{MinID: 1},
		{MinID: 2},
		{MinID: 3, Edges: []Edge{{From: 3, To: 4}}},
	}
	if !reflect.DeepEqual(segs, want) {
		t.Fatalf("after split: got %+v, want %+v", segs, want)
	}
}

func TestCorrectionMergesSegments(t *testing.T) {
	s := New(1, 100)
	// Two clusters just out of reach: {1,2} at x=0, {3,4} at x=15, r=10.
	s.Upsert(Point{ID: 1, T: 0, X: 0, Y: 0})
	s.Upsert(Point{ID: 2, T: 1, X: 0, Y: 0})
	s.Upsert(Point{ID: 3, T: 2, X: 15, Y: 0})
	s.Upsert(Point{ID: 4, T: 3, X: 15, Y: 0})
	if segs := s.Segments(); len(segs) != 2 {
		t.Fatalf("before correction: got %+v, want two segments", segs)
	}
	// Correct point 2 to x=5, bridging the clusters (5 and 10 both <= r).
	s.Upsert(Point{ID: 2, T: 1, X: 5, Y: 0})
	segs := s.Segments()
	want := []Segment{{
		MinID: 1,
		Edges: []Edge{{From: 1, To: 2}, {From: 2, To: 3}, {From: 3, To: 4}},
	}}
	if !reflect.DeepEqual(segs, want) {
		t.Fatalf("after merge: got %+v, want %+v", segs, want)
	}
}

func TestMinIDStableAcrossTimeOrder(t *testing.T) {
	s := New(10, 100)
	// Smallest ID is latest in time; MinID must still be the smallest member.
	s.Upsert(Point{ID: 7, T: 0, X: 0, Y: 0})
	s.Upsert(Point{ID: 3, T: 1, X: 1, Y: 0})
	s.Upsert(Point{ID: 9, T: 2, X: 2, Y: 0})
	segs := s.Segments()
	want := []Segment{{
		MinID: 3,
		Edges: []Edge{{From: 7, To: 3}, {From: 3, To: 9}},
	}}
	if !reflect.DeepEqual(segs, want) {
		t.Fatalf("got %+v, want %+v", segs, want)
	}
}

func TestRemoveSplitsSegment(t *testing.T) {
	s := New(1, 100)
	for i := 0; i < 3; i++ {
		s.Upsert(Point{ID: i + 1, T: int64(i), X: 0, Y: 0})
	}
	s.Remove(2) // remaining points have dt=2 > g
	segs := s.Segments()
	want := []Segment{{MinID: 1}, {MinID: 3}}
	if !reflect.DeepEqual(segs, want) {
		t.Fatalf("got %+v, want %+v", segs, want)
	}
}

// TestRandomUpdatesVsRebuild applies random corrections and removals to an
// incrementally maintained store and, after every operation, compares its
// output against a store rebuilt from scratch over the sorted point set.
func TestRandomUpdatesVsRebuild(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	const g, r2 = 5, 100
	inc := New(g, r2)
	live := make(map[int]Point)
	nextID := 1

	randomPoint := func(id int) Point {
		return Point{ID: id, T: int64(rng.Intn(200)), X: int64(rng.Intn(30)), Y: int64(rng.Intn(30))}
	}
	snapshot := func() []Point {
		pts := make([]Point, 0, len(live))
		for _, p := range live {
			pts = append(pts, p)
		}
		return pts
	}

	for step := 0; step < 2000; step++ {
		switch {
		case len(live) == 0 || rng.Intn(3) == 0: // insert new point
			p := randomPoint(nextID)
			nextID++
			inc.Upsert(p)
			live[p.ID] = p
		case rng.Intn(4) == 0: // remove a live point
			for id := range live {
				inc.Remove(id)
				delete(live, id)
				break
			}
		default: // correct a live point
			for id := range live {
				p := randomPoint(id)
				inc.Upsert(p)
				live[id] = p
				break
			}
		}

		got := inc.Segments()
		want := Build(snapshot(), g, r2).Segments()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("step %d: incremental %+v != rebuild %+v", step, got, want)
		}
		// Output must be deterministic across repeated calls.
		if again := inc.Segments(); !reflect.DeepEqual(got, again) {
			t.Fatalf("step %d: non-deterministic output %+v vs %+v", step, got, again)
		}
	}
}
