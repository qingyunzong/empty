package parity

import (
	"math/rand"
	"testing"
)

// checkCycle verifies that c.Edges is a simple cycle whose edge weights XOR
// to 1, and that every edge except the last (the rejected one) is present in
// the accepted-constraint multiset.
func checkCycle(t *testing.T, c *Conflict, accepted map[Edge]int, rejected Edge) {
	t.Helper()
	if len(c.Edges) == 0 {
		t.Fatal("conflict with empty cycle")
	}
	if got := c.Edges[len(c.Edges)-1]; got != rejected {
		t.Fatalf("last cycle edge = %v, want rejected edge %v", got, rejected)
	}
	xor := 0
	degree := map[int]int{}
	adj := map[int][]int{}
	for i, e := range c.Edges {
		xor ^= e.W
		if e.W != 0 && e.W != 1 {
			t.Fatalf("edge %d has bad weight %d", i, e.W)
		}
		if i < len(c.Edges)-1 {
			if accepted[e] == 0 {
				t.Fatalf("cycle edge %d %v is not an accepted constraint", i, e)
			}
		}
		if e.X == e.Y {
			// self-loop: a 1-edge cycle by itself
			if len(c.Edges) != 1 {
				t.Fatalf("self-loop inside longer cycle")
			}
			continue
		}
		degree[e.X]++
		degree[e.Y]++
		adj[e.X] = append(adj[e.X], i)
		adj[e.Y] = append(adj[e.Y], i)
	}
	if xor != 1 {
		t.Fatalf("cycle weight XOR = %d, want 1 (odd contradiction)", xor)
	}
	if len(c.Edges) == 1 {
		e := c.Edges[0]
		if e.X != e.Y || e.W != 1 {
			t.Fatalf("single-edge cycle = %v, want odd self-loop", e)
		}
		return
	}
	for v, d := range degree {
		if d != 2 {
			t.Fatalf("node %d has degree %d in cycle, want 2", v, d)
		}
	}
	// connectivity: walk the cycle
	seen := map[int]bool{}
	start := c.Edges[0].X
	cur, prev := start, -1
	for {
		seen[cur] = true
		next := -1
		for _, ei := range adj[cur] {
			e := c.Edges[ei]
			other := e.X
			if other == cur {
				other = e.Y
			}
			if other != prev {
				next = other
				break
			}
		}
		if next == -1 || next == start {
			break
		}
		prev, cur = cur, next
	}
	if len(seen) != len(degree) {
		t.Fatalf("cycle not connected: visited %d of %d nodes", len(seen), len(degree))
	}
}

func TestBasicRelations(t *testing.T) {
	u := New(4)
	if c := u.Union(0, 1, 0); c != nil {
		t.Fatalf("equal constraint rejected: %v", c)
	}
	if c := u.Union(1, 2, 1); c != nil {
		t.Fatalf("opposite constraint rejected: %v", c)
	}
	if p, ok := u.Query(0, 2); !ok || p != 1 {
		t.Fatalf("Query(0,2) = %d,%v, want 1,true", p, ok)
	}
	if p, ok := u.Query(1, 1); !ok || p != 0 {
		t.Fatalf("Query(1,1) = %d,%v, want 0,true", p, ok)
	}
	if _, ok := u.Query(0, 3); ok {
		t.Fatal("Query(0,3) connected, want disconnected")
	}
	// redundant consistent constraint is a no-op
	if c := u.Union(0, 2, 1); c != nil {
		t.Fatalf("redundant constraint rejected: %v", c)
	}
	if u.Savepoint() != 2 {
		t.Fatalf("journal grew on no-op union, savepoint = %d, want 2", u.Savepoint())
	}
}

func TestConflictTriangle(t *testing.T) {
	u := New(3)
	u.Union(0, 1, 0)
	u.Union(1, 2, 0)
	c := u.Union(0, 2, 1)
	if c == nil {
		t.Fatal("expected conflict, got nil")
	}
	accepted := map[Edge]int{{0, 1, 0}: 1, {1, 2, 0}: 1}
	checkCycle(t, c, accepted, Edge{0, 2, 1})
	if len(c.Edges) != 3 {
		t.Fatalf("triangle conflict cycle has %d edges, want 3", len(c.Edges))
	}
	// UF must be unchanged after the conflict.
	if p, ok := u.Query(0, 2); !ok || p != 0 {
		t.Fatalf("after conflict Query(0,2) = %d,%v, want 0,true", p, ok)
	}
}

func TestSelfLoopConflict(t *testing.T) {
	u := New(1)
	if c := u.Union(0, 0, 0); c != nil {
		t.Fatalf("x=x rejected: %v", c)
	}
	c := u.Union(0, 0, 1)
	if c == nil {
		t.Fatal("expected self-loop conflict")
	}
	checkCycle(t, c, map[Edge]int{}, Edge{0, 0, 1})
}

func TestSavepointRollback(t *testing.T) {
	u := New(5)
	u.Union(0, 1, 0)
	sp := u.Savepoint()
	u.Union(1, 2, 1)
	u.Union(2, 3, 0)
	if _, ok := u.Query(0, 3); !ok {
		t.Fatal("expected 0 and 3 connected before rollback")
	}
	u.Rollback(sp)
	if _, ok := u.Query(0, 3); ok {
		t.Fatal("0 and 3 still connected after rollback")
	}
	if p, ok := u.Query(0, 1); !ok || p != 0 {
		t.Fatalf("pre-savepoint relation lost: Query(0,1) = %d,%v", p, ok)
	}
	// A constraint that would have conflicted before rollback must now be
	// accepted, proving rollback fully restored the state.
	u.Union(1, 2, 1)
	u.Union(0, 2, 0)
	c := u.Union(0, 1, 1)
	if c == nil {
		t.Fatal("expected conflict after re-building contradictory triangle")
	}
	// Rollback everything and rebuild differently.
	u.Rollback(0)
	u.Union(0, 2, 0)
	u.Union(2, 1, 1)
	if p, ok := u.Query(0, 1); !ok || p != 1 {
		t.Fatalf("rebuilt relation Query(0,1) = %d,%v, want 1,true", p, ok)
	}
}

func TestBatchUndo(t *testing.T) {
	u := New(6)
	u.Union(0, 1, 0)
	u.Union(2, 3, 1)
	u.Union(4, 5, 0)
	if n := u.Undo(2); n != 2 {
		t.Fatalf("Undo(2) reverted %d merges, want 2", n)
	}
	if _, ok := u.Query(2, 3); ok {
		t.Fatal("2,3 still connected after undo")
	}
	if _, ok := u.Query(4, 5); ok {
		t.Fatal("4,5 still connected after undo")
	}
	if p, ok := u.Query(0, 1); !ok || p != 0 {
		t.Fatalf("0,1 relation lost: %d,%v", p, ok)
	}
	if n := u.Undo(10); n != 1 {
		t.Fatalf("Undo(10) reverted %d merges, want 1 (journal exhausted)", n)
	}
	if u.Savepoint() != 0 {
		t.Fatalf("journal not empty after full undo: %d", u.Savepoint())
	}
}

// model is the reference implementation: the plain list of active
// constraints, checked by full-graph 2-coloring.
type model struct {
	constraints []mEdge
}

type mEdge struct {
	x, y, w int
	merge   bool // whether the UF actually merged for this constraint
}

func (m *model) color(n int) ([]int, []bool) {
	adj := make([][]Edge, n)
	for _, c := range m.constraints {
		adj[c.x] = append(adj[c.x], Edge{X: c.x, Y: c.y, W: c.w})
		adj[c.y] = append(adj[c.y], Edge{X: c.y, Y: c.x, W: c.w})
	}
	color := make([]int, n)
	seen := make([]bool, n)
	for s := 0; s < n; s++ {
		if seen[s] {
			continue
		}
		seen[s] = true
		queue := []int{s}
		for len(queue) > 0 {
			x := queue[0]
			queue = queue[1:]
			for _, e := range adj[x] {
				if seen[e.Y] {
					continue
				}
				seen[e.Y] = true
				color[e.Y] = color[x] ^ e.W
				queue = append(queue, e.Y)
			}
		}
	}
	return color, seen
}

// checkVersion cross-checks the UF against a full-graph coloring of the
// active constraints for every pair of nodes.
func checkVersion(t *testing.T, u *UF, m *model) {
	t.Helper()
	n := u.Len()
	color, seen := m.color(n)
	comp := make([]int, n)
	id := 0
	for i := 0; i < n; i++ {
		comp[i] = -1
	}
	// label components via coloring BFS again (same traversal order)
	adj := make([][]Edge, n)
	for _, c := range m.constraints {
		adj[c.x] = append(adj[c.x], Edge{X: c.x, Y: c.y, W: c.w})
		adj[c.y] = append(adj[c.y], Edge{X: c.y, Y: c.x, W: c.w})
	}
	for s := 0; s < n; s++ {
		if comp[s] != -1 {
			continue
		}
		comp[s] = id
		queue := []int{s}
		for len(queue) > 0 {
			x := queue[0]
			queue = queue[1:]
			for _, e := range adj[x] {
				if comp[e.Y] == -1 {
					comp[e.Y] = id
					queue = append(queue, e.Y)
				}
			}
		}
		id++
	}
	for x := 0; x < n; x++ {
		for y := 0; y < n; y++ {
			p, ok := u.Query(x, y)
			if comp[x] != comp[y] {
				if ok {
					t.Fatalf("Query(%d,%d) connected in UF but not in model", x, y)
				}
				continue
			}
			if !ok {
				t.Fatalf("Query(%d,%d) disconnected in UF but connected in model", x, y)
			}
			if !seen[x] || !seen[y] {
				t.Fatalf("coloring missed node")
			}
			if want := color[x] ^ color[y]; p != want {
				t.Fatalf("Query(%d,%d) = %d, model says %d", x, y, p, want)
			}
		}
	}
}

func TestRandomHistoryAgainstColoring(t *testing.T) {
	const (
		trials   = 40
		ops      = 200
		maxNodes = 24
	)
	for trial := 0; trial < trials; trial++ {
		rng := rand.New(rand.NewSource(int64(trial)*7919 + 13))
		u := New(0)
		m := &model{}
		accepted := map[Edge]int{}
		type savepoint struct {
			sp          int
			constraints int
		}
		var stack []savepoint

		addAccepted := func(e Edge) {
			accepted[e]++
			if e.X != e.Y {
				accepted[Edge{X: e.Y, Y: e.X, W: e.W}]++
			}
		}
		removeAccepted := func(e Edge) {
			accepted[e]--
			if accepted[e] == 0 {
				delete(accepted, e)
			}
			if e.X != e.Y {
				r := Edge{X: e.Y, Y: e.X, W: e.W}
				accepted[r]--
				if accepted[r] == 0 {
					delete(accepted, r)
				}
			}
		}

		for op := 0; op < ops; op++ {
			n := u.Len()
			choice := rng.Intn(100)
			switch {
			case n == 0 || choice < 25:
				if n < maxNodes {
					u.Add()
				}
			case choice < 70:
				x, y, w := rng.Intn(n), rng.Intn(n), rng.Intn(2)
				before := u.Savepoint()
				c := u.Union(x, y, w)
				if c != nil {
					checkCycle(t, c, accepted, Edge{X: x, Y: y, W: w})
					if u.Savepoint() != before {
						t.Fatal("journal changed by rejected union")
					}
					break
				}
				merged := u.Savepoint() != before
				m.constraints = append(m.constraints, mEdge{x: x, y: y, w: w, merge: merged})
				addAccepted(Edge{X: x, Y: y, W: w})
			case choice < 82:
				stack = append(stack, savepoint{sp: u.Savepoint(), constraints: len(m.constraints)})
			case choice < 94:
				if len(stack) > 0 {
					i := rng.Intn(len(stack))
					s := stack[i]
					stack = stack[:i]
					u.Rollback(s.sp)
					for _, e := range m.constraints[s.constraints:] {
						removeAccepted(Edge{X: e.x, Y: e.y, W: e.w})
					}
					m.constraints = m.constraints[:s.constraints]
				}
			default:
				k := 1 + rng.Intn(4)
				undone := u.Undo(k)
				// Savepoints past the surviving journal are now invalid.
				for len(stack) > 0 && stack[len(stack)-1].sp > u.Savepoint() {
					stack = stack[:len(stack)-1]
				}
				for undone > 0 && len(m.constraints) > 0 {
					e := m.constraints[len(m.constraints)-1]
					m.constraints = m.constraints[:len(m.constraints)-1]
					removeAccepted(Edge{X: e.x, Y: e.y, W: e.w})
					if e.merge {
						undone--
					}
				}
				if undone != 0 {
					t.Fatalf("model/UF merge count mismatch: %d merges unaccounted", undone)
				}
			}
			checkVersion(t, u, m)
		}
	}
}
