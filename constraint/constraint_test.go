package constraint

import (
	"math/rand"
	"testing"
)

// reference is a naive full-graph coloring over the committed edges,
// used as ground truth for every version of the solver.
type reference struct {
	n     int
	edges []Edge
}

// color BFS-colors the whole graph; color[v] is -1 for unreached nodes.
// comp[v] is the connected-component id, or -1 for isolated nodes.
func (r *reference) color() (col, comp []int) {
	adj := make([][][2]int, r.n)
	for _, e := range r.edges {
		adj[e.X] = append(adj[e.X], [2]int{e.Y, e.Parity})
		adj[e.Y] = append(adj[e.Y], [2]int{e.X, e.Parity})
	}
	col = make([]int, r.n)
	comp = make([]int, r.n)
	for i := range col {
		col[i] = -1
		comp[i] = -1
	}
	ncomp := 0
	for s := 0; s < r.n; s++ {
		if len(adj[s]) == 0 || col[s] != -1 {
			continue
		}
		col[s] = 0
		comp[s] = ncomp
		queue := []int{s}
		for len(queue) > 0 {
			v := queue[0]
			queue = queue[1:]
			for _, a := range adj[v] {
				to, p := a[0], a[1]
				if col[to] == -1 {
					col[to] = col[v] ^ p
					comp[to] = ncomp
					queue = append(queue, to)
				}
			}
		}
		ncomp++
	}
	return col, comp
}

// consistent reports whether adding x XOR y = p keeps the graph
// conflict-free, and whether it merges two components (i.e. commits).
func (r *reference) consistent(x, y, p int) (ok, commits bool) {
	col, comp := r.color()
	if x != y && (comp[x] == -1 || comp[y] == -1 || comp[x] != comp[y]) {
		return true, true // different components: merges
	}
	if col[x]^col[y] == p {
		return true, false // redundant
	}
	return false, false // conflict
}

// checkVersion compares the solver against full-graph coloring for every
// pair of nodes, and verifies every committed edge's parity.
func checkVersion(t *testing.T, s *Solver, ref *reference, version int) {
	t.Helper()
	col, comp := ref.color()
	for x := 0; x < ref.n; x++ {
		for y := 0; y < ref.n; y++ {
			gotP, gotOK := s.Query(x, y)
			wantOK := x == y || comp[x] != -1 && comp[x] == comp[y]
			if gotOK != wantOK {
				t.Fatalf("version %d: Query(%d,%d) ok=%v, want %v", version, x, y, gotOK, wantOK)
			}
			if gotOK && gotP != col[x]^col[y] {
				t.Fatalf("version %d: Query(%d,%d) parity=%d, want %d", version, x, y, gotP, col[x]^col[y])
			}
		}
	}
	for _, e := range ref.edges {
		if p, ok := s.Query(e.X, e.Y); !ok || p != e.Parity {
			t.Fatalf("version %d: committed edge %+v violated (ok=%v p=%d)", version, e, ok, p)
		}
	}
}

// checkCycle validates a reported contradiction cycle: it must be a closed
// walk (every vertex has even degree, edges form one component) whose
// parity XOR is 1, and all edges but the last must be committed originals.
func checkCycle(t *testing.T, cyc []Edge, committed []Edge, rejected Edge) {
	t.Helper()
	if len(cyc) == 0 {
		t.Fatal("empty conflict cycle")
	}
	if cyc[len(cyc)-1] != rejected {
		t.Fatalf("cycle must end with rejected edge %+v, got %+v", rejected, cyc[len(cyc)-1])
	}
	set := make(map[Edge]int, len(committed))
	for _, e := range committed {
		set[e]++
	}
	for _, e := range cyc[:len(cyc)-1] {
		if set[e] == 0 {
			t.Fatalf("cycle edge %+v is not a committed original", e)
		}
		set[e]--
	}
	deg := make(map[int]int)
	adj := make(map[int][]int)
	xor := 0
	for _, e := range cyc {
		deg[e.X]++
		deg[e.Y]++
		adj[e.X] = append(adj[e.X], e.Y)
		adj[e.Y] = append(adj[e.Y], e.X)
		xor ^= e.Parity
	}
	if xor != 1 {
		t.Fatalf("cycle parity xor = %d, want 1 (odd contradiction)", xor)
	}
	for v, d := range deg {
		if d%2 != 0 {
			t.Fatalf("vertex %d has odd degree %d: not a closed walk; cyc=%v committed=%v", v, d, cyc, committed)
		}
	}
	// single connected component
	start := cyc[0].X
	seen := map[int]bool{start: true}
	queue := []int{start}
	for len(queue) > 0 {
		v := queue[0]
		queue = queue[1:]
		for _, to := range adj[v] {
			if !seen[to] {
				seen[to] = true
				queue = append(queue, to)
			}
		}
	}
	for v := range deg {
		if !seen[v] {
			t.Fatalf("cycle is disconnected: vertex %d unreachable", v)
		}
	}
}

// TestRandomHistory replays random add/savepoint/rollback histories and
// checks every version against full-graph coloring.
func TestRandomHistory(t *testing.T) {
	for trial := 0; trial < 30; trial++ {
		rng := rand.New(rand.NewSource(int64(trial)*7919 + 13))
		const n = 24
		s := New(n)
		ref := &reference{n: n}
		var spSolver []int // solver savepoints
		var spRef []int    // matching reference edge counts
		ops := 400
		for v := 0; v < ops; v++ {
			switch rng.Intn(10) {
			case 0, 1: // savepoint
				spSolver = append(spSolver, s.Savepoint())
				spRef = append(spRef, len(ref.edges))
			case 2, 3: // batch rollback
				if len(spSolver) > 0 {
					k := rng.Intn(len(spSolver))
					s.Rollback(spSolver[k])
					ref.edges = ref.edges[:spRef[k]]
					spSolver = spSolver[:k]
					spRef = spRef[:k]
				}
			default: // add constraint
				x, y, p := rng.Intn(n), rng.Intn(n), rng.Intn(2)
				ok, commits := ref.consistent(x, y, p)
				cyc := s.Add(x, y, p)
				if !ok {
					if cyc == nil {
						t.Fatalf("trial %d op %d: conflict not reported", trial, v)
					}
					checkCycle(t, cyc, ref.edges, Edge{X: x, Y: y, Parity: p})
				} else {
					if cyc != nil {
						t.Fatalf("trial %d op %d: spurious conflict cycle", trial, v)
					}
					if commits {
						ref.edges = append(ref.edges, Edge{X: x, Y: y, Parity: p})
					}
				}
			}
			checkVersion(t, s, ref, v)
		}
	}
}

// TestDeterministicConflict checks a hand-built odd cycle.
func TestDeterministicConflict(t *testing.T) {
	s := New(3)
	if c := s.Add(0, 1, 0); c != nil {
		t.Fatalf("unexpected conflict: %v", c)
	}
	if c := s.Add(1, 2, 0); c != nil {
		t.Fatalf("unexpected conflict: %v", c)
	}
	cyc := s.Add(0, 2, 1) // 0=1=2 but 0!=2
	if cyc == nil {
		t.Fatal("expected conflict cycle")
	}
	checkCycle(t, cyc, s.Edges(), Edge{X: 0, Y: 2, Parity: 1})
	if len(cyc) != 3 {
		t.Fatalf("want 3-edge cycle, got %d edges: %v", len(cyc), cyc)
	}

	// Rollback everything; all nodes must be unrelated again.
	s.Rollback(0)
	for x := 0; x < 3; x++ {
		for y := 0; y < 3; y++ {
			if x != y {
				if _, ok := s.Query(x, y); ok {
					t.Fatalf("after full rollback %d and %d still related", x, y)
				}
			}
		}
	}
	// Self-opposite is an immediate odd cycle of length 1.
	cyc = s.Add(1, 1, 1)
	if len(cyc) != 1 {
		t.Fatalf("want self-loop cycle, got %v", cyc)
	}
	checkCycle(t, cyc, s.Edges(), Edge{X: 1, Y: 1, Parity: 1})
}

// TestNestedSavepoints checks LIFO and non-LIFO batch rollback.
func TestNestedSavepoints(t *testing.T) {
	s := New(6)
	sp0 := s.Savepoint()
	s.Add(0, 1, 1)
	sp1 := s.Savepoint()
	s.Add(1, 2, 1)
	s.Add(2, 3, 1)
	sp2 := s.Savepoint()
	s.Add(3, 4, 0)

	if p, ok := s.Query(0, 4); !ok || p != 1 {
		t.Fatalf("0^4 = %d,%v want 1,true", p, ok)
	}
	s.Rollback(sp2) // undo one edge
	if _, ok := s.Query(0, 4); ok {
		t.Fatal("rollback to sp2 should unlink 0 and 4")
	}
	if p, ok := s.Query(0, 3); !ok || p != 1 {
		t.Fatalf("0^3 = %d,%v want 1,true", p, ok)
	}
	s.Rollback(sp0) // undo everything
	if _, ok := s.Query(0, 1); ok {
		t.Fatal("rollback to sp0 should unlink 0 and 1")
	}
	// Reuse after rollback still works.
	s.Add(4, 5, 0)
	if p, ok := s.Query(4, 5); !ok || p != 0 {
		t.Fatalf("4^5 = %d,%v want 0,true", p, ok)
	}
	_ = sp1
}
