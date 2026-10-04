package traj

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// rebuild is the independent reference: sort all points by (T, ID) and
// scan adjacent pairs in one pass.
func rebuild(pts map[int]Point, g, r int64) []Segment {
	list := make([]Point, 0, len(pts))
	for _, p := range pts {
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].T != list[j].T {
			return list[i].T < list[j].T
		}
		return list[i].ID < list[j].ID
	})
	r2 := r * r
	out := []Segment{}
	for i, p := range list {
		var q Point
		link := false
		if i > 0 {
			q = list[i-1]
			dt := p.T - q.T
			dx := p.X - q.X
			dy := p.Y - q.Y
			link = dt >= 0 && dt <= g && dx*dx+dy*dy <= r2
		}
		if !link {
			out = append(out, Segment{MinID: p.ID, Size: 1})
			continue
		}
		cur := &out[len(out)-1]
		cur.Size++
		if p.ID < cur.MinID {
			cur.MinID = p.ID
		}
		cur.Edges = append(cur.Edges, Edge{A: q.ID, B: p.ID})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MinID < out[j].MinID })
	return out
}

func segStrings(segs []Segment) []string {
	var out []string
	for _, s := range segs {
		out = append(out, fmt.Sprintf("min=%d size=%d edges=%v", s.MinID, s.Size, s.Edges))
	}
	return out
}

func check(t *testing.T, ix *Index, live map[int]Point, g, r int64) {
	t.Helper()
	got, want := ix.Segments(), rebuild(live, g, r)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mismatch:\n got: %v\nwant: %v", segStrings(got), segStrings(want))
	}
}

func TestTimeGapBoundary(t *testing.T) {
	ix := New(10, 100)
	live := map[int]Point{}
	add := func(p Point) { ix.Upsert(p); live[p.ID] = p }

	add(Point{ID: 1, T: 0})
	add(Point{ID: 2, T: 10}) // dt == g: linked
	add(Point{ID: 3, T: 21}) // dt = 11 > g: broken
	check(t, ix, live, 10, 100)

	segs := ix.Segments()
	if len(segs) != 2 || segs[0].MinID != 1 || segs[0].Size != 2 || segs[1].MinID != 3 {
		t.Fatalf("unexpected segments: %v", segStrings(segs))
	}
	if !reflect.DeepEqual(segs[0].Edges, []Edge{{A: 1, B: 2}}) {
		t.Fatalf("unexpected edges: %v", segs[0].Edges)
	}
}

func TestDistanceBoundaryIntegerOnly(t *testing.T) {
	ix := New(100, 5) // r^2 = 25, compared as integers
	live := map[int]Point{}
	add := func(p Point) { ix.Upsert(p); live[p.ID] = p }

	add(Point{ID: 1, T: 0, X: 0, Y: 0})
	add(Point{ID: 2, T: 1, X: 3, Y: 4})  // 3-4-5: dx^2+dy^2 = 25 == r^2: linked
	add(Point{ID: 3, T: 2, X: 6, Y: 9})  // 9+25 = 34 > 25: broken
	add(Point{ID: 4, T: 3, X: 6, Y: 14}) // 0+25 = 25 == r^2: linked to 3
	check(t, ix, live, 100, 5)

	segs := ix.Segments()
	if len(segs) != 2 || segs[0].Size != 2 || segs[1].Size != 2 {
		t.Fatalf("unexpected segments: %v", segStrings(segs))
	}
}

func TestEqualTimestampsLink(t *testing.T) {
	ix := New(0, 2) // g = 0: only identical timestamps may link
	live := map[int]Point{}
	add := func(p Point) { ix.Upsert(p); live[p.ID] = p }

	add(Point{ID: 1, T: 7, X: 0, Y: 0})
	add(Point{ID: 2, T: 7, X: 1, Y: 1}) // dt = 0, dist^2 = 2 <= 4: linked
	add(Point{ID: 3, T: 8, X: 1, Y: 1}) // dt = 1 > g: broken
	check(t, ix, live, 0, 2)
	if segs := ix.Segments(); len(segs) != 2 || segs[0].Size != 2 {
		t.Fatalf("unexpected segments: %v", segStrings(segs))
	}
}

func TestCorrectionSplitsAndMerges(t *testing.T) {
	ix := New(5, 10)
	live := map[int]Point{}
	up := func(p Point) { ix.Upsert(p); live[p.ID] = p }

	up(Point{ID: 1, T: 0, X: 0, Y: 0})
	up(Point{ID: 2, T: 5, X: 0, Y: 0})
	up(Point{ID: 3, T: 10, X: 0, Y: 0})
	check(t, ix, live, 5, 10)
	if segs := ix.Segments(); len(segs) != 1 || segs[0].MinID != 1 || segs[0].Size != 3 {
		t.Fatalf("expected one segment, got %v", segStrings(segs))
	}

	// Correct point 2 far into the future: the chain splits into three
	// singletons because 1 and 3 are 10 > g apart as well.
	up(Point{ID: 2, T: 100, X: 0, Y: 0})
	check(t, ix, live, 5, 10)
	if segs := ix.Segments(); len(segs) != 3 {
		t.Fatalf("expected split into 3, got %v", segStrings(segs))
	}

	// Correct it back: the three singletons merge again.
	up(Point{ID: 2, T: 5, X: 0, Y: 0})
	check(t, ix, live, 5, 10)
	if segs := ix.Segments(); len(segs) != 1 || segs[0].Size != 3 {
		t.Fatalf("expected merge into 1, got %v", segStrings(segs))
	}

	// Spatial correction: jump point 2 away in space, then return.
	up(Point{ID: 2, T: 5, X: 1000, Y: 0})
	check(t, ix, live, 5, 10)
	if segs := ix.Segments(); len(segs) != 3 {
		t.Fatalf("expected spatial split, got %v", segStrings(segs))
	}
	up(Point{ID: 2, T: 5, X: 0, Y: 0})
	check(t, ix, live, 5, 10)
	if segs := ix.Segments(); len(segs) != 1 {
		t.Fatalf("expected spatial merge, got %v", segStrings(segs))
	}

	// Correction that reorders: move point 1 behind point 3.
	up(Point{ID: 1, T: 12, X: 0, Y: 0})
	check(t, ix, live, 5, 10)
	segs := ix.Segments()
	if len(segs) != 1 {
		t.Fatalf("expected reorder to stay merged, got %v", segStrings(segs))
	}
	wantEdges := []Edge{{A: 2, B: 3}, {A: 3, B: 1}}
	if !reflect.DeepEqual(segs[0].Edges, wantEdges) {
		t.Fatalf("edges not in time order: got %v want %v", segs[0].Edges, wantEdges)
	}
}

func TestCorrectionMergesTwoSegments(t *testing.T) {
	ix := New(5, 10)
	live := map[int]Point{}
	up := func(p Point) { ix.Upsert(p); live[p.ID] = p }

	up(Point{ID: 1, T: 0, X: 0, Y: 0})
	up(Point{ID: 2, T: 10, X: 0, Y: 0}) // dt = 10 > g: separate
	check(t, ix, live, 5, 10)
	if segs := ix.Segments(); len(segs) != 2 {
		t.Fatalf("expected 2 segments, got %v", segStrings(segs))
	}

	up(Point{ID: 2, T: 4, X: 0, Y: 0}) // now dt = 4 <= g: merge
	check(t, ix, live, 5, 10)
	segs := ix.Segments()
	if len(segs) != 1 || segs[0].MinID != 1 {
		t.Fatalf("expected merge, got %v", segStrings(segs))
	}
}

func TestRemoveSplitsOrKeepsSegment(t *testing.T) {
	ix := New(5, 10)
	live := map[int]Point{}
	up := func(p Point) { ix.Upsert(p); live[p.ID] = p }
	rm := func(id int) { ix.Remove(id); delete(live, id) }

	// 1 and 3 are 10 apart (> g), so bridge point 2 holds them together.
	up(Point{ID: 1, T: 0, X: 0, Y: 0})
	up(Point{ID: 2, T: 5, X: 0, Y: 0})
	up(Point{ID: 3, T: 10, X: 0, Y: 0})
	rm(2)
	check(t, ix, live, 5, 10)
	if segs := ix.Segments(); len(segs) != 2 {
		t.Fatalf("expected removal to split, got %v", segStrings(segs))
	}

	// Here 4 and 6 are 4 apart (<= g), so removing bridge 5 keeps one segment.
	up(Point{ID: 4, T: 20, X: 0, Y: 0})
	up(Point{ID: 5, T: 22, X: 0, Y: 0})
	up(Point{ID: 6, T: 24, X: 0, Y: 0})
	rm(5)
	check(t, ix, live, 5, 10)
	segs := ix.Segments()
	if len(segs) != 3 {
		t.Fatalf("expected 3 segments, got %v", segStrings(segs))
	}
	var tail Segment
	for _, s := range segs {
		if s.MinID == 4 {
			tail = s
		}
	}
	if tail.Size != 2 || !reflect.DeepEqual(tail.Edges, []Edge{{A: 4, B: 6}}) {
		t.Fatalf("expected 4-6 to stay linked, got %v", segStrings(segs))
	}
}

func TestOutOfOrderInsertion(t *testing.T) {
	ix := New(5, 10)
	live := map[int]Point{}
	up := func(p Point) { ix.Upsert(p); live[p.ID] = p }

	up(Point{ID: 9, T: 10, X: 0, Y: 0})
	up(Point{ID: 7, T: 0, X: 0, Y: 0})
	up(Point{ID: 8, T: 5, X: 0, Y: 0})
	check(t, ix, live, 5, 10)
	segs := ix.Segments()
	if len(segs) != 1 || segs[0].MinID != 7 {
		t.Fatalf("unexpected segments: %v", segStrings(segs))
	}
	want := []Edge{{A: 7, B: 8}, {A: 8, B: 9}}
	if !reflect.DeepEqual(segs[0].Edges, want) {
		t.Fatalf("edges got %v want %v", segs[0].Edges, want)
	}
}

func TestEmptyAndSingleton(t *testing.T) {
	ix := New(5, 5)
	if got := ix.Segments(); len(got) != 0 {
		t.Fatalf("expected no segments, got %v", got)
	}
	ix.Upsert(Point{ID: 3, T: 1, X: 2, Y: 2})
	check(t, ix, map[int]Point{3: {ID: 3, T: 1, X: 2, Y: 2}}, 5, 5)
	ix.Remove(3)
	ix.Remove(3) // removing twice is a no-op
	if got := ix.Segments(); len(got) != 0 {
		t.Fatalf("expected no segments, got %v", got)
	}
}

func TestRandomUpdatesMatchRebuild(t *testing.T) {
	const g, r = 5, 4
	for _, seed := range []int64{1, 2, 3, 42, 2026} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			ix := New(g, r)
			live := map[int]Point{}
			nextID := 1
			randPoint := func(id int) Point {
				return Point{
					ID: id,
					T:  int64(rng.Intn(60)),
					X:  int64(rng.Intn(12)),
					Y:  int64(rng.Intn(12)),
				}
			}
			someID := func() int {
				k := rng.Intn(len(live))
				for id := range live {
					if k == 0 {
						return id
					}
					k--
				}
				panic("unreachable")
			}
			for op := 0; op < 3000; op++ {
				switch roll := rng.Intn(100); {
				case len(live) == 0 || roll < 50:
					p := randPoint(nextID)
					nextID++
					ix.Upsert(p)
					live[p.ID] = p
				case roll < 80:
					p := randPoint(someID())
					ix.Upsert(p)
					live[p.ID] = p
				default:
					id := someID()
					ix.Remove(id)
					delete(live, id)
				}
				check(t, ix, live, g, r)
			}
			if ix.Len() != len(live) {
				t.Fatalf("Len = %d, want %d", ix.Len(), len(live))
			}
		})
	}
}
