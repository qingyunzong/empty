package geom_test

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"

	"geom"
)

// --- Independent naive model (brute force, no production code) ---

func cross3(o, a, b geom.Point) int64 {
	return (a.X-o.X)*(b.Y-o.Y) - (a.Y-o.Y)*(b.X-o.X)
}

func sortedUnique(pts []geom.Point) []geom.Point {
	s := append([]geom.Point(nil), pts...)
	sort.Slice(s, func(i, j int) bool {
		return s[i].X < s[j].X || (s[i].X == s[j].X && s[i].Y < s[j].Y)
	})
	out := s[:0]
	for i, p := range s {
		if i == 0 || p != s[i-1] {
			out = append(out, p)
		}
	}
	return out
}

func onSeg(a, b, p geom.Point) bool {
	return cross3(a, b, p) == 0 &&
		p.X >= min(a.X, b.X) && p.X <= max(a.X, b.X) &&
		p.Y >= min(a.Y, b.Y) && p.Y <= max(a.Y, b.Y)
}

// naiveHull builds the hull by testing every ordered pair as a candidate
// supporting line: (a,b) is a hull edge iff no point lies strictly right of
// it and no collinear point lies outside segment ab.
func naiveHull(pts []geom.Point) []geom.Point {
	s := sortedUnique(pts)
	if len(s) <= 2 {
		return s
	}
	collinear := true
	for _, p := range s[2:] {
		if cross3(s[0], s[1], p) != 0 {
			collinear = false
			break
		}
	}
	if collinear {
		return []geom.Point{s[0], s[len(s)-1]}
	}
	next := map[geom.Point]geom.Point{}
	for _, a := range s {
		for _, b := range s {
			if a == b {
				continue
			}
			ok := true
			for _, p := range s {
				if c := cross3(a, b, p); c < 0 || (c == 0 && !onSeg(a, b, p)) {
					ok = false
					break
				}
			}
			if ok {
				if _, dup := next[a]; dup {
					panic("ambiguous supporting edge")
				}
				next[a] = b
			}
		}
	}
	start := s[0]
	if _, ok := next[start]; !ok {
		panic("lex-min point has no outgoing hull edge")
	}
	hull := []geom.Point{start}
	for cur := next[start]; cur != start; cur = next[cur] {
		hull = append(hull, cur)
		if len(hull) > len(s) {
			panic("hull walk did not close")
		}
	}
	return hull
}

func naiveOnBoundary(hull []geom.Point, p geom.Point) bool {
	if len(hull) == 1 {
		return p == hull[0]
	}
	for i := range hull {
		if onSeg(hull[i], hull[(i+1)%len(hull)], p) {
			return true
		}
	}
	return false
}

// naiveLayers peels the set with the naive hull, removing every boundary
// point (vertices and edge-collinear points) at each depth.
func naiveLayers(pts []geom.Point) [][]geom.Point {
	remaining := sortedUnique(pts)
	var layers [][]geom.Point
	for len(remaining) > 0 {
		h := naiveHull(remaining)
		layers = append(layers, h)
		next := remaining[:0]
		for _, p := range remaining {
			if !naiveOnBoundary(h, p) {
				next = append(next, p)
			}
		}
		remaining = next
	}
	return layers
}

func naiveRank(pts []geom.Point, p geom.Point) int {
	remaining := sortedUnique(pts)
	for i := 0; ; i++ {
		h := naiveHull(remaining)
		if naiveOnBoundary(h, p) {
			return i
		}
		next := remaining[:0]
		for _, q := range remaining {
			if !naiveOnBoundary(h, q) {
				next = append(next, q)
			}
		}
		remaining = next
	}
}

func shoelace2(poly []geom.Point) int64 {
	var sum int64
	for i := range poly {
		j := (i + 1) % len(poly)
		sum += poly[i].X*poly[j].Y - poly[j].X*poly[i].Y
	}
	if sum < 0 {
		sum = -sum
	}
	return sum
}

// --- Model-vs-library checking ---

func checkSnapshot(t *testing.T, s *geom.Snapshot, model map[int64]geom.Point) {
	t.Helper()

	if s.Len() != len(model) {
		t.Fatalf("Len = %d, want %d", s.Len(), len(model))
	}
	pts := make([]geom.Point, 0, len(model))
	for id, p := range model {
		if got, ok := s.Get(id); !ok || got != p {
			t.Fatalf("Get(%d) = %v,%v, want %v", id, got, ok, p)
		}
		pts = append(pts, p)
	}

	// Hull vs naive supporting-line model.
	wantHull := naiveHull(pts)
	if got := s.Hull(); !reflect.DeepEqual(got, wantHull) {
		t.Fatalf("Hull = %v, want %v (pts %v)", got, wantHull, pts)
	}
	// Naive supporting-line verification of every version.
	if err := geom.VerifyHull(pts, s.Hull()); err != nil {
		t.Fatalf("VerifyHull: %v (pts %v)", err, pts)
	}
	if got, want := s.Area2(), shoelace2(wantHull); got != want {
		t.Fatalf("Area2 = %d, want %d", got, want)
	}

	// Layers and per-layer areas vs naive peeling model.
	wantLayers := naiveLayers(pts)
	if got := s.Layers(); !reflect.DeepEqual(got, wantLayers) {
		t.Fatalf("Layers = %v, want %v (pts %v)", got, wantLayers, pts)
	}
	wantAreas := make([]int64, len(wantLayers))
	for i, l := range wantLayers {
		wantAreas[i] = shoelace2(l)
	}
	if got := s.LayerAreas2(); !reflect.DeepEqual(got, wantAreas) {
		t.Fatalf("LayerAreas2 = %v, want %v", got, wantAreas)
	}

	// Ranks of every ID, plus duplicate-coordinate grouping.
	ranks := s.Ranks()
	if len(ranks) != len(model) {
		t.Fatalf("Ranks covers %d IDs, want %d", len(ranks), len(model))
	}
	for id, p := range model {
		want := naiveRank(pts, p)
		if got, ok := s.Rank(id); !ok || got != want {
			t.Fatalf("Rank(%d) = %d,%v, want %d", id, got, ok, want)
		}
		if ranks[id] != want {
			t.Fatalf("Ranks()[%d] = %d, want %d", id, ranks[id], want)
		}
	}
	groups := map[geom.Point][]int64{}
	for id, p := range model {
		groups[p] = append(groups[p], id)
	}
	for p, ids := range groups {
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		if got := s.Group(p); !reflect.DeepEqual(got, ids) {
			t.Fatalf("Group(%v) = %v, want %v", p, got, ids)
		}
	}
}

func copyModel(m map[int64]geom.Point) map[int64]geom.Point {
	out := make(map[int64]geom.Point, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func TestRandomBatchesAgainstNaiveModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	snap := geom.New()
	model := map[int64]geom.Point{}
	type branch struct {
		snap  *geom.Snapshot
		model map[int64]geom.Point
	}
	var branches []branch

	for round := 0; round < 400; round++ {
		cur := snap
		for n := 1 + rng.Intn(10); n > 0; n-- {
			id := int64(rng.Intn(48))
			if rng.Intn(3) == 0 {
				cur = cur.Remove(id)
				delete(model, id)
			} else {
				p := geom.Point{X: int64(rng.Intn(13) - 6), Y: int64(rng.Intn(13) - 6)}
				cur = cur.Add(id, p)
				model[id] = p
			}
		}
		snap = cur
		checkSnapshot(t, snap, model)
		if round%40 == 0 {
			branches = append(branches, branch{snap, copyModel(model)})
		}
	}

	// Kept branch snapshots must still answer exactly as when taken:
	// persistent structural sharing, no retroactive mutation.
	for i, b := range branches {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("branch %d: %v", i, r)
				}
			}()
			checkSnapshot(t, b.snap, b.model)
		}()
	}
}

// TestVerifyHullRejectsBadHulls sanity-checks the verifier itself.
func TestVerifyHullRejectsBadHulls(t *testing.T) {
	pts := []geom.Point{P(0, 0), P(2, 0), P(2, 2), P(0, 2), P(1, 1)}
	if err := geom.VerifyHull(pts, []geom.Point{P(0, 0), P(2, 0), P(2, 2), P(0, 2)}); err != nil {
		t.Fatalf("valid hull rejected: %v", err)
	}
	bad := [][]geom.Point{
		{P(0, 0), P(2, 2), P(2, 0), P(0, 2)},          // clockwise-ish / self-crossing
		{P(0, 0), P(2, 0), P(2, 2)},                   // missing vertex
		{P(2, 0), P(2, 2), P(0, 2), P(0, 0)},          // not starting at lex-min
		{P(0, 0), P(2, 0), P(2, 2), P(0, 2), P(9, 9)}, // vertex not in set
		{P(0, 0), P(1, 1), P(2, 0), P(2, 2), P(0, 2)}, // interior point as vertex
	}
	for i, h := range bad {
		if err := geom.VerifyHull(pts, h); err == nil {
			t.Fatalf("bad hull %d accepted: %v", i, h)
		}
	}
}
