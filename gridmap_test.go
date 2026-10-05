package gridmap

import (
	"container/heap"
	"math/rand"
	"testing"
)

// --- reference implementations (independent of the library internals) ---

// refNeighbors lists legal moves with costs, re-derived from the rules.
func refNeighbors(m *Map, p Point) []struct {
	q Point
	c int
} {
	var out []struct {
		q Point
		c int
	}
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if dx == 0 && dy == 0 {
				continue
			}
			q := Point{p.X + dx, p.Y + dy}
			if !m.Free(q) {
				continue
			}
			if dx != 0 && dy != 0 {
				if !m.Free(Point{p.X + dx, p.Y}) || !m.Free(Point{p.X, p.Y + dy}) {
					continue // corner cutting forbidden
				}
				out = append(out, struct {
					q Point
					c int
				}{q, DiagCost})
			} else {
				out = append(out, struct {
					q Point
					c int
				}{q, OrthoCost})
			}
		}
	}
	return out
}

// refDijkstra is a plain full Dijkstra from s over the whole grid.
func refDijkstra(m *Map, s Point) map[Point]int {
	dist := map[Point]int{s: 0}
	h := &refHeap{{s, 0}}
	for h.Len() > 0 {
		it := heap.Pop(h).(refItem)
		if it.d > dist[it.p] {
			continue
		}
		for _, nb := range refNeighbors(m, it.p) {
			if nd := it.d + nb.c; nd < dist[nb.q] || !has(dist, nb.q) {
				dist[nb.q] = nd
				heap.Push(h, refItem{nb.q, nd})
			}
		}
	}
	return dist
}

func has(m map[Point]int, p Point) bool { _, ok := m[p]; return ok }

type refItem struct {
	p Point
	d int
}
type refHeap []refItem

func (h refHeap) Len() int            { return len(h) }
func (h refHeap) Less(i, j int) bool  { return h[i].d < h[j].d }
func (h refHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *refHeap) Push(x interface{}) { *h = append(*h, x.(refItem)) }
func (h *refHeap) Pop() interface{} {
	old := *h
	it := old[len(old)-1]
	*h = old[:len(old)-1]
	return it
}

// enumLexMin enumerates every simple path from s to t whose cost equals
// target and returns the lexicographically smallest coordinate sequence.
// distToT (from a reference Dijkstra) prunes the search.
func enumLexMin(m *Map, s, t Point, target int, distToT map[Point]int) []Point {
	var best []Point
	visited := map[Point]bool{s: true}
	var rec func(cur Point, acc int, path []Point)
	rec = func(cur Point, acc int, path []Point) {
		if cur == t {
			if acc != target {
				return
			}
			if best == nil || lexLess(path, best) {
				best = append([]Point(nil), path...)
			}
			return
		}
		for _, nb := range refNeighbors(m, cur) {
			if visited[nb.q] {
				continue
			}
			d, ok := distToT[nb.q]
			if !ok || acc+nb.c+d > target {
				continue
			}
			visited[nb.q] = true
			rec(nb.q, acc+nb.c, append(path, nb.q))
			delete(visited, nb.q)
		}
	}
	rec(s, 0, []Point{s})
	return best
}

func lexLess(a, b []Point) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i].Less(b[i])
		}
	}
	return len(a) < len(b)
}

func freeCells(m *Map) []Point {
	var out []Point
	for y := 0; y < m.Height(); y++ {
		for x := 0; x < m.Width(); x++ {
			if m.Free(Point{x, y}) {
				out = append(out, Point{x, y})
			}
		}
	}
	return out
}

// --- deterministic unit tests ---

func TestCornerCuttingForbidden(t *testing.T) {
	m := New(3, 3).Apply(Edit{Point{1, 0}, true}, Edit{Point{0, 1}, true})
	if _, ok := m.StepCost(Point{0, 0}, Point{1, 1}); ok {
		t.Fatal("diagonal through two blocked corners must be illegal")
	}
	m1 := New(3, 3).Apply(Edit{Point{1, 0}, true})
	if _, ok := m1.StepCost(Point{0, 0}, Point{1, 1}); ok {
		t.Fatal("diagonal past one blocked corner must be illegal")
	}
	m2 := New(3, 3).Apply(Edit{Point{1, 1}, true})
	if _, ok := m2.StepCost(Point{0, 0}, Point{1, 1}); ok {
		t.Fatal("diagonal onto an obstacle must be illegal")
	}
	if c, ok := New(3, 3).StepCost(Point{0, 0}, Point{1, 1}); !ok || c != DiagCost {
		t.Fatalf("open diagonal: got cost %d ok %v, want %d true", c, ok, DiagCost)
	}
	if _, ok := m.ShortestPath(Point{0, 0}, Point{1, 1}); ok {
		t.Fatal("no path should exist around a sealed corner on this map")
	}
}

func TestBatchEditAndSnapshotIsolation(t *testing.T) {
	m0 := New(5, 5)
	edits := []Edit{
		{Point{2, 0}, true}, {Point{2, 1}, true}, {Point{2, 2}, true},
		{Point{2, 3}, true}, {Point{2, 4}, true}, // vertical wall
		{Point{9, 9}, true}, // out of bounds: ignored
	}
	m1 := m0.Apply(edits...)
	// Old snapshot must be unaffected and still queryable.
	for _, e := range edits[:5] {
		if m0.Blocked(e.P) {
			t.Fatalf("snapshot m0 mutated at %v", e.P)
		}
		if !m1.Blocked(e.P) {
			t.Fatalf("edit not applied at %v", e.P)
		}
	}
	if _, ok := m1.ShortestPath(Point{0, 0}, Point{4, 4}); ok {
		t.Fatal("wall should disconnect the map on m1")
	}
	r, ok := m0.ShortestPath(Point{0, 0}, Point{4, 4})
	if !ok || r.Dist != 4*DiagCost {
		t.Fatalf("m0 query: got %+v ok=%v", r, ok)
	}
	// Clearing edits in a later batch must not touch m1 either.
	m2 := m1.Apply(Edit{Point{2, 2}, false})
	if m1.Free(Point{2, 2}) || !m2.Free(Point{2, 2}) {
		t.Fatal("clear edit leaked across snapshots")
	}
	if _, ok := m2.ShortestPath(Point{0, 0}, Point{4, 4}); !ok {
		t.Fatal("gap in wall should reconnect m2")
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	m := New(3, 3)
	r, ok := m.ShortestPath(Point{0, 0}, Point{2, 1})
	if !ok {
		t.Fatal("expected a path")
	}
	want := []Point{{0, 0}, {1, 0}, {2, 1}} // cost 24, lexicographically minimal
	if r.Dist != 24 {
		t.Fatalf("dist = %d, want 24", r.Dist)
	}
	if len(r.Path) != len(want) {
		t.Fatalf("path = %v, want %v", r.Path, want)
	}
	for i := range want {
		if r.Path[i] != want[i] {
			t.Fatalf("path = %v, want %v", r.Path, want)
		}
	}
}

func TestCertificateVerify(t *testing.T) {
	m := New(6, 6).Apply(Edit{Point{2, 2}, true}, Edit{Point{3, 2}, true})
	r, ok := m.ShortestPath(Point{0, 0}, Point{5, 5})
	if !ok {
		t.Fatal("expected a path")
	}
	if !r.Cert.Verify(m) {
		t.Fatal("valid certificate rejected")
	}
	// Certificate must not verify against a different map.
	m2 := m.Apply(Edit{Point{1, 1}, true})
	if r.Cert.Verify(m2) {
		t.Fatal("certificate verified against mutated map")
	}
	// Tampered certificates must be rejected.
	bad := *r.Cert
	bad.Dist++
	if bad.Verify(m) {
		t.Fatal("accepted certificate with wrong distance")
	}
	bad = *r.Cert
	bad.Path = append([]Point(nil), r.Cert.Path...)
	bad.Path[1] = Point{0, 0} // illegal non-move
	if bad.Verify(m) {
		t.Fatal("accepted certificate with illegal path")
	}
	bad = *r.Cert
	bad.Labels = map[Point]int{}
	for p, d := range r.Cert.Labels {
		bad.Labels[p] = d
	}
	delete(bad.Labels, Point{4, 4}) // hole in the label set
	if bad.Verify(m) {
		t.Fatal("accepted certificate with missing label")
	}
}

func TestSameStartGoal(t *testing.T) {
	m := New(2, 2)
	r, ok := m.ShortestPath(Point{1, 1}, Point{1, 1})
	if !ok || r.Dist != 0 || len(r.Path) != 1 || !r.Cert.Verify(m) {
		t.Fatalf("degenerate query: %+v ok=%v", r, ok)
	}
}

// --- randomized cross-checks ---

func TestRandomUpdatesVsFullDijkstra(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 60; trial++ {
		m := New(4+rng.Intn(5), 4+rng.Intn(5))
		snaps := []*Map{m}
		// Random batch edits across rounds; keep every snapshot.
		for round := 0; round < 6; round++ {
			var edits []Edit
			for k := 0; k < 1+rng.Intn(6); k++ {
				edits = append(edits, Edit{
					P:     Point{rng.Intn(m.Width()), rng.Intn(m.Height())},
					Block: rng.Float64() < 0.35,
				})
			}
			m = m.Apply(edits...)
			snaps = append(snaps, m)
		}
		for _, snap := range snaps {
			cells := freeCells(snap)
			if len(cells) == 0 {
				continue
			}
			for q := 0; q < 4; q++ {
				s := cells[rng.Intn(len(cells))]
				g := cells[rng.Intn(len(cells))]
				ref := refDijkstra(snap, s)
				r, ok := snap.ShortestPath(s, g)
				refD, reach := ref[g]
				if ok != reach {
					t.Fatalf("trial %d: reachability mismatch for %v->%v", trial, s, g)
				}
				if !ok {
					continue
				}
				if r.Dist != refD {
					t.Fatalf("trial %d: dist %d, reference %d (%v->%v)", trial, r.Dist, refD, s, g)
				}
				if !r.Cert.Verify(snap) {
					t.Fatalf("trial %d: certificate failed for %v->%v", trial, s, g)
				}
			}
		}
	}
}

func TestSmallMapsVsExhaustiveEnumeration(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for trial := 0; trial < 40; trial++ {
		m := New(3+rng.Intn(2), 3+rng.Intn(2))
		var edits []Edit
		for y := 0; y < m.Height(); y++ {
			for x := 0; x < m.Width(); x++ {
				if rng.Float64() < 0.3 {
					edits = append(edits, Edit{Point{x, y}, true})
				}
			}
		}
		m = m.Apply(edits...)
		cells := freeCells(m)
		if len(cells) < 2 {
			continue
		}
		for q := 0; q < 3; q++ {
			s := cells[rng.Intn(len(cells))]
			g := cells[rng.Intn(len(cells))]
			ref := refDijkstra(m, g) // distances to goal
			r, ok := m.ShortestPath(s, g)
			d, reach := ref[s]
			if ok != reach {
				t.Fatalf("trial %d: reachability mismatch %v->%v", trial, s, g)
			}
			if !ok {
				continue
			}
			want := enumLexMin(m, s, g, d, ref)
			if want == nil {
				t.Fatalf("trial %d: enumeration found no path %v->%v", trial, s, g)
			}
			if r.Dist != d {
				t.Fatalf("trial %d: dist %d, want %d", trial, r.Dist, d)
			}
			if len(r.Path) != len(want) {
				t.Fatalf("trial %d: path %v, enumerated optimum %v", trial, r.Path, want)
			}
			for i := range want {
				if r.Path[i] != want[i] {
					t.Fatalf("trial %d: path %v, enumerated optimum %v", trial, r.Path, want)
				}
			}
		}
	}
}
