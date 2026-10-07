package gridmap

import (
	"math/rand"
	"testing"
)

// refDijkstra is an independent, deliberately simple O(V^2) Dijkstra used
// only by tests to cross-check the library.
func refDijkstra(s *Snapshot, from Coord) map[Coord]int {
	dist := map[Coord]int{from: 0}
	done := map[Coord]bool{}
	for {
		var u Coord
		best := -1
		for c, d := range dist {
			if !done[c] && (best < 0 || d < best) {
				u, best = c, d
			}
		}
		if best < 0 {
			return dist
		}
		done[u] = true
		for _, n := range s.Neighbors(u) {
			if nd := best + n.Cost; nd < dist[n.Cell] || !done[n.Cell] && dist[n.Cell] == 0 {
				if cur, ok := dist[n.Cell]; !ok || nd < cur {
					dist[n.Cell] = nd
				}
			}
		}
	}
}

// enumerate walks every simple path from cur to to, tracking the cheapest
// cost and, among cheapest, the lexicographically smallest coordinate
// sequence. Exponential; only for tiny grids.
func enumerate(s *Snapshot, cur, to Coord, seen map[Coord]bool, path []Coord, cost int, best *struct {
	cost int
	path []Coord
}) {
	if cur == to {
		if best.path == nil || cost < best.cost || (cost == best.cost && pathLess(path, best.path)) {
			best.cost = cost
			best.path = append([]Coord{}, path...)
		}
		return
	}
	if best.path != nil && cost >= best.cost {
		return
	}
	seen[cur] = true
	defer delete(seen, cur)
	for _, n := range s.Neighbors(cur) {
		if seen[n.Cell] {
			continue
		}
		enumerate(s, n.Cell, to, seen, append(path, n.Cell), cost+n.Cost, best)
	}
}

// pathLess compares coordinate sequences lexicographically.
func pathLess(a, b []Coord) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i].Less(b[i])
		}
	}
	return len(a) < len(b)
}

func TestRandomUpdatesVsReferenceDijkstra(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 60; trial++ {
		w := 3 + rng.Intn(10)
		h := 3 + rng.Intn(10)
		m, err := New(w, h)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		// Random sequence of batch edits, keeping every snapshot.
		var snaps []*Snapshot
		snaps = append(snaps, mustSnap(t, m, 0))
		for b := 0; b < 8; b++ {
			n := rng.Intn(6)
			edits := make([]Edit, 0, n)
			for i := 0; i < n; i++ {
				edits = append(edits, Edit{
					Cell:  Coord{rng.Intn(w), rng.Intn(h)},
					Block: rng.Intn(2) == 0,
				})
			}
			s, err := m.ApplyBatch(edits)
			if err != nil {
				t.Fatalf("ApplyBatch: %v", err)
			}
			snaps = append(snaps, s)
		}
		// Cross-check random queries on random (including old) snapshots.
		for q := 0; q < 20; q++ {
			s := snaps[rng.Intn(len(snaps))]
			from := Coord{rng.Intn(w), rng.Intn(h)}
			to := Coord{rng.Intn(w), rng.Intn(h)}

			var wantDist int
			wantOK := false
			if !s.Blocked(from) && !s.Blocked(to) {
				if d, ok := refDijkstra(s, to)[from]; ok {
					wantDist, wantOK = d, true
				}
			}
			gotPath, gotDist, gotOK := ShortestPath(s, from, to)
			if gotOK != wantOK {
				t.Fatalf("trial %d snap v%d %v->%v: ok=%v, reference ok=%v", trial, s.Version(), from, to, gotOK, wantOK)
			}
			if !gotOK {
				continue
			}
			if gotDist != wantDist {
				t.Fatalf("trial %d snap v%d %v->%v: dist=%d, reference=%d", trial, s.Version(), from, to, gotDist, wantDist)
			}
			// Path must be legal and attain the distance.
			if gotPath[0] != from || gotPath[len(gotPath)-1] != to {
				t.Fatalf("trial %d: path endpoints %v..%v, want %v..%v", trial, gotPath[0], gotPath[len(gotPath)-1], from, to)
			}
			total := 0
			for i := 1; i < len(gotPath); i++ {
				c, ok := s.MoveCost(gotPath[i-1], gotPath[i])
				if !ok {
					t.Fatalf("trial %d: illegal move %v -> %v", trial, gotPath[i-1], gotPath[i])
				}
				total += c
			}
			if total != gotDist {
				t.Fatalf("trial %d: path cost %d != dist %d", trial, total, gotDist)
			}
			// Certificate must verify.
			cert, ok := ShortestPathCertificate(s, from, to)
			if !ok {
				t.Fatalf("trial %d: no certificate for reachable query", trial)
			}
			if err := cert.Verify(s); err != nil {
				t.Fatalf("trial %d: certificate rejected: %v", trial, err)
			}
			if cert.Dist != gotDist {
				t.Fatalf("trial %d: cert dist %d != path dist %d", trial, cert.Dist, gotDist)
			}
		}
	}
}

func TestSmallGridEnumeration(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for trial := 0; trial < 400; trial++ {
		w := 2 + rng.Intn(3) // 2..4
		h := 2 + rng.Intn(3)
		m, err := New(w, h)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		var edits []Edit
		for x := 0; x < w; x++ {
			for y := 0; y < h; y++ {
				if rng.Intn(3) == 0 {
					edits = append(edits, Edit{Cell: Coord{x, y}, Block: true})
				}
			}
		}
		s, err := m.ApplyBatch(edits)
		if err != nil {
			t.Fatalf("ApplyBatch: %v", err)
		}
		from := Coord{rng.Intn(w), rng.Intn(h)}
		to := Coord{rng.Intn(w), rng.Intn(h)}
		if s.Blocked(from) || s.Blocked(to) {
			continue
		}
		best := struct {
			cost int
			path []Coord
		}{}
		enumerate(s, from, to, map[Coord]bool{}, []Coord{from}, 0, &best)

		gotPath, gotDist, gotOK := ShortestPath(s, from, to)
		if (best.path != nil) != gotOK {
			t.Fatalf("trial %d (%dx%d %v->%v): ok=%v, enumeration ok=%v", trial, w, h, from, to, gotOK, best.path != nil)
		}
		if !gotOK {
			continue
		}
		if gotDist != best.cost {
			t.Fatalf("trial %d (%dx%d %v->%v): dist=%d, enumeration=%d", trial, w, h, from, to, gotDist, best.cost)
		}
		if !equalPath(gotPath, best.path) {
			t.Fatalf("trial %d (%dx%d %v->%v): path=%v, lex-min enumeration=%v", trial, w, h, from, to, gotPath, best.path)
		}
	}
}

func equalPath(a, b []Coord) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
