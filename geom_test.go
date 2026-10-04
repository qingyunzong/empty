package geomlib

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// ---------- naive independent model (used only by tests) ----------

func crossT(a, b, c Point) int64 { return cross(a, b, c) }

func dist2(a, b Point) int64 {
	dx, dy := a.X-b.X, a.Y-b.Y
	return dx*dx + dy*dy
}

// modelHull computes the convex hull by brute-force supporting-line
// enumeration: a directed edge a->b is a hull edge iff every point lies on
// or to its left. Chaining farthest qualifying endpoints yields the hull
// counterclockwise from the lexicographic minimum, endpoints only, and
// collapses all-collinear sets to the two extremes.
func modelHull(pts []Point) []Point {
	if len(pts) <= 1 {
		out := make([]Point, len(pts))
		copy(out, pts)
		return out
	}
	start := pts[0]
	for _, p := range pts {
		if lessPoint(p, start) {
			start = p
		}
	}
	hull := []Point{start}
	cur := start
	for i := 0; i <= len(pts); i++ {
		var next Point
		best := int64(-1)
		for _, b := range pts {
			if b == cur {
				continue
			}
			ok := true
			for _, p := range pts {
				if crossT(cur, b, p) < 0 {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
			if d := dist2(cur, b); d > best {
				best, next = d, b
			}
		}
		if best < 0 || next == start {
			break
		}
		hull = append(hull, next)
		cur = next
	}
	return hull
}

// modelLayers peels layers from scratch with the brute-force hull.
func modelLayers(pts []Point) []Layer {
	pts = append([]Point(nil), pts...) // work on a copy; never mutate caller's slice
	var layers []Layer
	for len(pts) > 0 {
		h := modelHull(pts)
		layers = append(layers, Layer{Rank: len(layers) + 1, Hull: h, Area2: area2(h)})
		inHull := make(map[Point]bool, len(h))
		for _, p := range h {
			inHull[p] = true
		}
		rest := pts[:0]
		for _, p := range pts {
			if !inHull[p] {
				rest = append(rest, p)
			}
		}
		pts = rest
	}
	return layers
}

// checkHullNaive verifies hull against pts with O(n*h) supporting-line
// checks, plus orientation, start vertex, and endpoint-only edge rules.
func checkHullNaive(t *testing.T, pts []Point, hull []Point) {
	t.Helper()
	inSet := make(map[Point]bool, len(pts))
	for _, p := range pts {
		inSet[p] = true
	}
	onHull := make(map[Point]bool, len(hull))
	for i, v := range hull {
		if !inSet[v] {
			t.Fatalf("hull vertex %v not in point set", v)
		}
		if onHull[v] {
			t.Fatalf("hull vertex %v repeated", v)
		}
		onHull[v] = true
		if i > 0 && lessPoint(v, hull[0]) {
			t.Fatalf("hull does not start at lexicographic minimum: %v", hull)
		}
	}
	if len(hull) >= 3 {
		if a := area2(hull); a <= 0 {
			t.Fatalf("hull not counterclockwise / degenerate: %v (area2=%d)", hull, a)
		}
		for i := range hull {
			a, b, c := hull[i], hull[(i+1)%len(hull)], hull[(i+2)%len(hull)]
			if crossT(a, b, c) <= 0 {
				t.Fatalf("hull has collinear or reflex triple at %v,%v,%v", a, b, c)
			}
		}
	}
	// Supporting-line check: every point lies on or left of every edge.
	for i := range hull {
		a, b := hull[i], hull[(i+1)%len(hull)]
		for _, p := range pts {
			if crossT(a, b, p) < 0 {
				t.Fatalf("point %v strictly right of hull edge %v->%v", p, a, b)
			}
		}
	}
}

func uniqueSorted(pts []Point) []Point {
	seen := make(map[Point]bool, len(pts))
	out := pts[:0]
	for _, p := range pts {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return lessPoint(out[i], out[j]) })
	return out
}

// ---------- targeted tests ----------

func TestHullBasics(t *testing.T) {
	s := New()
	if got := s.Hull(); len(got) != 0 {
		t.Fatalf("empty hull = %v", got)
	}
	s = s.Add(1, Point{3, 4})
	if got := s.Hull(); !reflect.DeepEqual(got, []Point{{3, 4}}) {
		t.Fatalf("single hull = %v", got)
	}
	if a := s.Area2(); a != 0 {
		t.Fatalf("single area2 = %d", a)
	}
}

func TestAllCollinear(t *testing.T) {
	s := New()
	for i, x := range []int64{5, -2, 7, 0, 3} {
		s = s.Add(int64(i), Point{x, 2 * x}) // all on y=2x
	}
	want := []Point{{-2, -4}, {7, 14}}
	if got := s.Hull(); !reflect.DeepEqual(got, want) {
		t.Fatalf("collinear hull = %v, want %v", got, want)
	}
	if a := s.Area2(); a != 0 {
		t.Fatalf("collinear area2 = %d", a)
	}
	pts := uniqueSorted([]Point{{5, 10}, {-2, -4}, {7, 14}, {0, 0}, {3, 6}})
	checkHullNaive(t, pts, s.Hull())
}

func TestCollinearOnEdgesDropped(t *testing.T) {
	s := New()
	pts := []Point{{0, 0}, {4, 0}, {2, 0}, {4, 4}, {2, 4}, {0, 4}, {0, 2}, {1, 1}}
	for i, p := range pts {
		s = s.Add(int64(i), p)
	}
	want := []Point{{0, 0}, {4, 0}, {4, 4}, {0, 4}}
	if got := s.Hull(); !reflect.DeepEqual(got, want) {
		t.Fatalf("hull = %v, want %v", got, want)
	}
	if a := s.Area2(); a != 32 {
		t.Fatalf("area2 = %d, want 32", a)
	}
	checkHullNaive(t, uniqueSorted(append([]Point(nil), pts...)), s.Hull())
}

func TestDuplicatesGroupedByID(t *testing.T) {
	s := New()
	s = s.Add(1, Point{0, 0})
	s = s.Add(2, Point{0, 0})
	s = s.Add(3, Point{0, 0})
	s = s.Add(4, Point{5, 0})
	s = s.Add(5, Point{0, 5})
	if n := s.Len(); n != 3 {
		t.Fatalf("distinct points = %d, want 3", n)
	}
	if n := s.IDs(); n != 5 {
		t.Fatalf("ids = %d, want 5", n)
	}
	if got := s.Sources(Point{0, 0}); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("sources = %v", got)
	}
	s = s.Remove(2)
	if got := s.Sources(Point{0, 0}); !reflect.DeepEqual(got, []int64{1, 3}) {
		t.Fatalf("sources after remove = %v", got)
	}
	if n := s.Len(); n != 3 {
		t.Fatalf("point vanished while sources remain: %d", n)
	}
	s = s.Remove(1).Remove(3)
	if n := s.Len(); n != 2 {
		t.Fatalf("point should vanish with last source: %d", n)
	}
	if got := s.Sources(Point{0, 0}); got != nil {
		t.Fatalf("sources of vanished point = %v", got)
	}
}

func TestCorrectionChangesAllLayers(t *testing.T) {
	s := New()
	// 3x3 grid: outer layer (4 corners + edge midpoints dropped) and inner
	// layer containing only the center.
	for x := int64(0); x < 3; x++ {
		for y := int64(0); y < 3; y++ {
			s = s.Add(x*3+y, Point{x, y})
		}
	}
	before := s.Layers()
	if len(before) != 3 || len(before[2].Hull) != 1 || before[2].Hull[0] != (Point{1, 1}) {
		t.Fatalf("grid layers = %+v", before)
	}
	// Correct the interior center to far outside: everything re-layers.
	s2 := s.Add(4, Point{10, 1})
	after := s2.Layers()
	if len(after) != 2 {
		t.Fatalf("after correction layers = %+v", after)
	}
	if reflect.DeepEqual(before, after) {
		t.Fatalf("correction did not change layers")
	}
	// Old snapshot must be untouched.
	if got := s.Layers(); !reflect.DeepEqual(got, before) {
		t.Fatalf("old snapshot mutated: %+v", got)
	}
}

func TestBranchSnapshotsShareAndPersist(t *testing.T) {
	base := New()
	for i, p := range []Point{{0, 0}, {6, 0}, {6, 6}, {0, 6}, {3, 3}} {
		base = base.Add(int64(i), p)
	}
	branchA := base.Add(100, Point{3, -5})
	branchB := base.Remove(4).Add(101, Point{9, 3})
	if got := base.Hull(); !reflect.DeepEqual(got, []Point{{0, 0}, {6, 0}, {6, 6}, {0, 6}}) {
		t.Fatalf("base mutated: %v", got)
	}
	checkHullNaive(t, []Point{{0, 0}, {6, 0}, {6, 6}, {0, 6}, {3, 3}, {3, -5}}, branchA.Hull())
	if got := branchA.Hull(); !reflect.DeepEqual(got, []Point{{0, 0}, {3, -5}, {6, 0}, {6, 6}, {0, 6}}) {
		t.Fatalf("branchA hull = %v", got)
	}
	if got := branchB.Hull(); !reflect.DeepEqual(got, []Point{{0, 0}, {6, 0}, {9, 3}, {6, 6}, {0, 6}}) {
		t.Fatalf("branchB hull = %v", got)
	}
	// Structural sharing: branches must reuse base's interior nodes.
	if &base.st.byCoord.root == &branchA.st.byCoord.root {
		t.Fatalf("impossible")
	}
	shared := 0
	countShared(base.st.byCoord.root, branchA.st.byCoord.root, &shared)
	if shared == 0 {
		t.Fatalf("no structural sharing between base and branch")
	}
}

func countShared(a, b *pnode[Point, []int64], n *int) {
	if a == nil || b == nil {
		return
	}
	if a == b {
		*n++
		return
	}
	countShared(a.left, b.left, n)
	countShared(a.right, b.right, n)
}

// ---------- randomized differential test ----------

func TestRandomBatchesVsModel(t *testing.T) {
	for _, seed := range []int64{20261005, 1, 7, 999} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runRandomBatches(t, seed)
		})
	}
}

func runRandomBatches(t *testing.T, seed int64) {
	rng := rand.New(rand.NewSource(seed))
	snap := New()
	ids := make(map[int64]Point) // reference model state
	var kept []Snapshot
	var keptModel []map[int64]Point

	for batch := 0; batch < 200; batch++ {
		ops := 1 + rng.Intn(12)
		for o := 0; o < ops; o++ {
			id := int64(rng.Intn(60))
			switch rng.Intn(10) {
			case 0, 1: // remove
				snap = snap.Remove(id)
				delete(ids, id)
			default: // add or correct
				p := Point{int64(rng.Intn(31) - 15), int64(rng.Intn(31) - 15)}
				snap = snap.Add(id, p)
				ids[id] = p
			}
		}
		// Reference geometry from scratch.
		set := make(map[Point][]int64)
		for id, p := range ids {
			set[p] = append(set[p], id)
		}
		pts := make([]Point, 0, len(set))
		for p := range set {
			pts = append(pts, p)
		}
		pts = uniqueSorted(pts)

		// 1. Hull matches brute-force supporting-line model.
		wantHull := modelHull(pts)
		if got := snap.Hull(); !reflect.DeepEqual(got, wantHull) {
			t.Fatalf("batch %d: hull = %v, want %v", batch, got, wantHull)
		}
		// 2. Naive supporting-line check on this version.
		checkHullNaive(t, pts, snap.Hull())
		// 3. Doubled area matches model hull area.
		if got, want := snap.Area2(), area2(wantHull); got != want {
			t.Fatalf("batch %d: area2 = %d, want %d", batch, got, want)
		}
		// 4. Layers match the from-scratch peeling model.
		wantLayers := modelLayers(pts)
		gotLayers := snap.Layers()
		if !reflect.DeepEqual(gotLayers, wantLayers) {
			t.Fatalf("batch %d: layers = %+v, want %+v", batch, gotLayers, wantLayers)
		}
		remaining := append([]Point(nil), pts...)
		for _, l := range gotLayers {
			checkHullNaive(t, remaining, l.Hull)
			inHull := make(map[Point]bool, len(l.Hull))
			for _, p := range l.Hull {
				inHull[p] = true
			}
			rest := remaining[:0]
			for _, p := range remaining {
				if !inHull[p] {
					rest = append(rest, p)
				}
			}
			remaining = rest
		}
		// 5. Duplicate-coordinate grouping matches.
		for p, wantIDs := range set {
			sort.Slice(wantIDs, func(i, j int) bool { return wantIDs[i] < wantIDs[j] })
			if got := snap.Sources(p); !reflect.DeepEqual(got, wantIDs) {
				t.Fatalf("batch %d: sources(%v) = %v, want %v", batch, p, got, wantIDs)
			}
		}
		if snap.Len() != len(pts) || snap.IDs() != len(ids) {
			t.Fatalf("batch %d: sizes (%d,%d), want (%d,%d)", batch, snap.Len(), snap.IDs(), len(pts), len(ids))
		}
		// Keep some versions to re-verify persistence later.
		if batch%25 == 0 {
			kept = append(kept, snap)
			cp := make(map[int64]Point, len(ids))
			for id, p := range ids {
				cp[id] = p
			}
			keptModel = append(keptModel, cp)
		}
	}

	// 6. Old snapshots still answer correctly after all later updates.
	for i, s := range kept {
		pts := make([]Point, 0, len(keptModel[i]))
		seen := map[Point]bool{}
		for _, p := range keptModel[i] {
			if !seen[p] {
				seen[p] = true
				pts = append(pts, p)
			}
		}
		pts = uniqueSorted(pts)
		if got, want := s.Hull(), modelHull(pts); !reflect.DeepEqual(got, want) {
			t.Fatalf("kept snapshot %d: hull = %v, want %v", i, got, want)
		}
		if got, want := s.Layers(), modelLayers(pts); !reflect.DeepEqual(got, want) {
			t.Fatalf("kept snapshot %d: layers diverged", i)
		}
	}
}
