// Package constraint maintains equality/opposite (parity) relations between
// nodes with savepoints, batch rollback, and odd-cycle conflict reporting.
//
// Relations are of the form x XOR y = p, where p == 0 means "equal" and
// p == 1 means "opposite". The implementation is a weighted union-find
// that deliberately avoids path compression: parent chains always consist
// of original constraint edges, so rollback is a pure log replay and
// conflict cycles can be reported over the original edges.
package constraint

// Edge is an original constraint: X XOR Y = Parity.
type Edge struct {
	X, Y   int
	Parity int // 0 = equal, 1 = opposite
}

type undoEntry struct {
	child      int // root that was attached
	parent     int // root it was attached to
	parentSize int // size of parent before the attach
}

// Solver tracks parity constraints over nodes 0..n-1.
type Solver struct {
	parent   []int
	toParent []int // parity to parent
	size     []int
	edges    []Edge
	log      []undoEntry
}

// New returns a Solver for n nodes.
func New(n int) *Solver {
	s := &Solver{
		parent:   make([]int, n),
		toParent: make([]int, n),
		size:     make([]int, n),
	}
	for i := 0; i < n; i++ {
		s.parent[i] = i
		s.size[i] = 1
	}
	return s
}

// find walks to the root without path compression, accumulating parity.
func (s *Solver) find(x int) (root, parity int) {
	root = x
	for s.parent[root] != root {
		parity ^= s.toParent[root]
		root = s.parent[root]
	}
	return root, parity
}

// Add commits the constraint x XOR y = p. It returns nil if the constraint
// is consistent (committed or redundant). On conflict nothing is committed
// and the returned cycle is the odd-parity contradiction: original edges
// forming the path between x and y, followed by the rejected edge itself.
func (s *Solver) Add(x, y, p int) []Edge {
	rx, px := s.find(x)
	ry, py := s.find(y)
	if rx == ry {
		if px^py != p {
			return s.cycle(x, y, p)
		}
		return nil
	}
	if s.size[rx] > s.size[ry] {
		rx, ry = ry, rx
		px, py = py, px
	}
	s.edges = append(s.edges, Edge{X: x, Y: y, Parity: p})
	s.parent[rx] = ry
	s.toParent[rx] = px ^ py ^ p
	s.log = append(s.log, undoEntry{child: rx, parent: ry, parentSize: s.size[ry]})
	s.size[ry] += s.size[rx]
	return nil
}

// cycle builds the contradiction cycle for the rejected edge x XOR y = p:
// a path of committed original edges from x to y (found by BFS over the
// original graph), followed by the rejected edge itself. The union-find
// tree cannot be used here: the original edge that merged two sets does
// not necessarily touch the tree parent/child nodes, so tree edges do not
// form a path in the original graph.
func (s *Solver) cycle(x, y, p int) []Edge {
	adj := make([][][2]int, len(s.parent)) // adjacency: node -> {neighbor, edge id}
	for id, e := range s.edges {
		adj[e.X] = append(adj[e.X], [2]int{e.Y, id})
		adj[e.Y] = append(adj[e.Y], [2]int{e.X, id})
	}
	prev := make([][2]int, len(s.parent)) // prev[v] = {node, edge id} we reached v from
	for i := range prev {
		prev[i] = [2]int{-1, -1}
	}
	prev[x][0] = x
	queue := []int{x}
	for len(queue) > 0 && prev[y][0] == -1 {
		v := queue[0]
		queue = queue[1:]
		for _, a := range adj[v] {
			if prev[a[0]][0] == -1 {
				prev[a[0]] = [2]int{v, a[1]}
				queue = append(queue, a[0])
			}
		}
	}
	cyc := []Edge{}
	for v := y; v != x; {
		id := prev[v][1]
		cyc = append(cyc, s.edges[id])
		v = prev[v][0]
	}
	for i, j := 0, len(cyc)-1; i < j; i, j = i+1, j-1 {
		cyc[i], cyc[j] = cyc[j], cyc[i]
	}
	return append(cyc, Edge{X: x, Y: y, Parity: p})
}

// Savepoint returns a token for the current version.
func (s *Solver) Savepoint() int { return len(s.log) }

// Rollback undoes every constraint added after the savepoint, in batch.
func (s *Solver) Rollback(sp int) {
	for len(s.log) > sp {
		u := s.log[len(s.log)-1]
		s.log = s.log[:len(s.log)-1]
		s.parent[u.child] = u.child
		s.toParent[u.child] = 0
		s.size[u.parent] = u.parentSize
		s.edges = s.edges[:len(s.edges)-1]
	}
}

// Query reports the parity between x and y, or ok=false if unrelated.
func (s *Solver) Query(x, y int) (parity int, ok bool) {
	rx, px := s.find(x)
	ry, py := s.find(y)
	if rx != ry {
		return 0, false
	}
	return px ^ py, true
}

// Edges returns the currently committed original constraints.
func (s *Solver) Edges() []Edge { return s.edges }
