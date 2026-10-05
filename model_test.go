package diffc

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// This file cross-checks the library against a brute-force model that
// enumerates every simple path and every simple cycle of small graphs.

// bruteNegativeCycle reports whether the constraint graph contains any
// negative simple cycle, by enumerating all simple cycles. Edges run
// from Y to X with weight C (the constraint X - Y <= C).
func bruteNegativeCycle(cons []Constraint) bool {
	nodes := nodeSet(cons)
	adj := map[int][]Constraint{}
	for _, c := range cons {
		adj[c.Y] = append(adj[c.Y], c)
	}
	for _, start := range nodes {
		// DFS over simple paths that only visit nodes >= start, so each
		// simple cycle is discovered exactly once (at its minimum node).
		visited := map[int]bool{start: true}
		var walk func(v int, sum int64) bool
		walk = func(v int, sum int64) bool {
			for _, e := range adj[v] {
				if e.X == start && sum+e.C < 0 {
					return true // closed a negative cycle at start
				}
				if e.X < start || visited[e.X] {
					continue
				}
				visited[e.X] = true
				if walk(e.X, sum+e.C) {
					return true
				}
				delete(visited, e.X)
			}
			return false
		}
		if walk(start, 0) {
			return true
		}
	}
	return false
}

// bruteDistances computes exact shortest distances from a virtual
// zero-weight source by enumerating all simple paths. Only valid when
// no negative cycle exists.
func bruteDistances(cons []Constraint) map[int]int64 {
	nodes := nodeSet(cons)
	adj := map[int][]Constraint{}
	for _, c := range cons {
		adj[c.Y] = append(adj[c.Y], c)
	}
	dist := map[int]int64{}
	for _, v := range nodes {
		dist[v] = 0 // virtual source edge of weight 0
	}
	for _, start := range nodes {
		visited := map[int]bool{start: true}
		var walk func(v int, sum int64)
		walk = func(v int, sum int64) {
			if sum < dist[v] {
				dist[v] = sum
			}
			for _, e := range adj[v] {
				if visited[e.X] {
					continue
				}
				visited[e.X] = true
				walk(e.X, sum+e.C)
				delete(visited, e.X)
			}
		}
		walk(start, 0)
	}
	return dist
}

func nodeSet(cons []Constraint) []int {
	set := map[int]bool{}
	for _, c := range cons {
		set[c.X] = true
		set[c.Y] = true
	}
	out := make([]int, 0, len(set))
	for v := range set {
		out = append(out, v)
	}
	sort.Ints(out)
	return out
}

// buildSystem replays constraints into a System using the same IDs.
func buildSystem(cons []Constraint) *System {
	s := New()
	for _, c := range cons {
		if got := s.Add(c.X, c.Y, c.C); got != c.ID {
			panic("ID mismatch in test harness")
		}
	}
	return s
}

func TestCrossCheckSmallGraphs(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	const trials = 3000
	feasible, infeasible := 0, 0
	for trial := 0; trial < trials; trial++ {
		n := 1 + rng.Intn(5) // 1..5 variables
		m := rng.Intn(9)     // 0..8 constraints
		var cons []Constraint
		for i := 0; i < m; i++ {
			c := Constraint{
				ID: i + 1,
				X:  rng.Intn(n),
				Y:  rng.Intn(n),
				C:  int64(rng.Intn(15) - 6), // weights in [-6, 8]
			}
			cons = append(cons, c)
		}
		snap := buildSystem(cons).Snapshot()
		cert := snap.Solve()

		// The library's own certificate must verify independently.
		if err := snap.Verify(cert); err != nil {
			t.Fatalf("trial %d: certificate failed verification: %v\ncons=%v", trial, err, cons)
		}

		wantFeasible := !bruteNegativeCycle(cons)
		if cert.Feasible != wantFeasible {
			t.Fatalf("trial %d: feasibility mismatch: lib=%v brute=%v\ncons=%v",
				trial, cert.Feasible, wantFeasible, cons)
		}
		if cert.Feasible {
			feasible++
			// Bellman-Ford potentials must equal exact shortest
			// distances from the virtual source.
			want := bruteDistances(cons)
			if !reflect.DeepEqual(cert.Potentials, want) {
				t.Fatalf("trial %d: potentials %v, brute-force distances %v\ncons=%v",
					trial, cert.Potentials, want, cons)
			}
		} else {
			infeasible++
		}
	}
	t.Logf("cross-checked %d graphs: %d feasible, %d infeasible", trials, feasible, infeasible)
	if feasible == 0 || infeasible == 0 {
		t.Fatalf("random generator covered only one case: %d feasible, %d infeasible", feasible, infeasible)
	}
}

func TestCrossCheckUndoAndSnapshots(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	s := New()
	type record struct {
		snap Snapshot
		cert Certificate
	}
	var snapshots []record
	var certs []Certificate // certificate before each mutation, for undo checks

	ops := 0
	for step := 0; step < 400; step++ {
		switch rng.Intn(5) {
		case 0: // add
			certs = append(certs, s.Snapshot().Solve())
			s.Add(rng.Intn(5), rng.Intn(5), int64(rng.Intn(13)-6))
			ops++
		case 1: // remove a random live constraint
			cons := s.Snapshot().Constraints()
			if len(cons) == 0 {
				continue
			}
			certs = append(certs, s.Snapshot().Solve())
			s.Remove(cons[rng.Intn(len(cons))].ID)
			ops++
		case 2: // atomic batch
			cons := s.Snapshot().Constraints()
			var edits []Edit
			for _, c := range cons {
				if rng.Intn(3) == 0 {
					edits = append(edits, Edit{Remove: true, ID: c.ID})
				}
			}
			for i := 0; i < rng.Intn(3); i++ {
				edits = append(edits, Edit{X: rng.Intn(5), Y: rng.Intn(5), C: int64(rng.Intn(13) - 6)})
			}
			certs = append(certs, s.Snapshot().Solve())
			if _, err := s.Apply(edits...); err != nil {
				t.Fatalf("step %d: unexpected Apply error: %v", step, err)
			}
			ops++
		case 3: // snapshot (must stay readable forever)
			snap := s.Snapshot()
			snapshots = append(snapshots, record{snap, snap.Solve()})
		case 4: // undo (must restore the previous certificate)
			if len(certs) == 0 || ops == 0 {
				continue
			}
			want := certs[len(certs)-1]
			certs = certs[:len(certs)-1]
			if !s.Undo() {
				t.Fatalf("step %d: Undo failed with %d recorded ops", step, ops)
			}
			ops--
			got := s.Snapshot().Solve()
			if !reflect.DeepEqual(want, got) {
				t.Fatalf("step %d: undo restored %+v, want %+v", step, got, want)
			}
		}
		// The live system always yields a verifiable certificate.
		snap := s.Snapshot()
		if err := snap.Verify(snap.Solve()); err != nil {
			t.Fatalf("step %d: live certificate invalid: %v", step, err)
		}
	}

	// Every old snapshot must still solve to its original certificate.
	for i, r := range snapshots {
		got := r.snap.Solve()
		if !reflect.DeepEqual(r.cert, got) {
			t.Fatalf("snapshot %d changed over time: %+v -> %+v", i, r.cert, got)
		}
		if err := r.snap.Verify(got); err != nil {
			t.Fatalf("snapshot %d certificate no longer verifies: %v", i, err)
		}
	}
	t.Logf("finished with %d constraints, %d pinned snapshots", s.Len(), len(snapshots))
}
