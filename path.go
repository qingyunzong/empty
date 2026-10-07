package gridmap

import (
	"container/heap"
	"fmt"
)

// Certificate is a distance certificate for a shortest-path query. It
// proves optimality: Path attains Dist (upper bound) and Labels is a
// feasible potential over every cell reachable from From (lower bound).
// When From cannot reach To, Dist is -1, Path is nil, and Labels covers
// exactly the reachable component, proving unreachability.
type Certificate struct {
	From, To Coord
	Dist     int           // shortest distance, or -1 if unreachable
	Path     []Coord       // nil when unreachable
	Labels   map[Coord]int // dist(From, v) for every reachable v
}

// Verify checks the certificate against a snapshot. It returns nil iff
// the certificate proves Dist is the true shortest distance from From to
// To on s (or proves unreachability when Dist == -1).
func (c *Certificate) Verify(s *Snapshot) error {
	if c.Labels == nil {
		return fmt.Errorf("gridmap: certificate has no labels")
	}
	if d, ok := c.Labels[c.From]; !ok || d != 0 {
		return fmt.Errorf("gridmap: label of source %v is %d, want 0", c.From, d)
	}
	// Feasibility + closedness: for every labeled cell u and every legal
	// move u->v, v must be labeled with label[v] <= label[u] + cost.
	for u, du := range c.Labels {
		if du < 0 {
			return fmt.Errorf("gridmap: negative label at %v", u)
		}
		for _, n := range s.Neighbors(u) {
			dv, ok := c.Labels[n.Cell]
			if !ok {
				return fmt.Errorf("gridmap: reachable cell %v (via %v) is unlabeled", n.Cell, u)
			}
			if dv > du+n.Cost {
				return fmt.Errorf("gridmap: infeasible labels: d%v=%d > d%v=%d + %d", n.Cell, dv, u, du, n.Cost)
			}
		}
	}
	dt, ok := c.Labels[c.To]
	if c.Dist == -1 {
		if ok {
			return fmt.Errorf("gridmap: certificate claims unreachability but target is labeled %d", dt)
		}
		return nil
	}
	if !ok || dt != c.Dist {
		return fmt.Errorf("gridmap: target label %d (present=%v) != certified distance %d", dt, ok, c.Dist)
	}
	// The path must be legal and attain Dist.
	if len(c.Path) == 0 || c.Path[0] != c.From || c.Path[len(c.Path)-1] != c.To {
		return fmt.Errorf("gridmap: path endpoints do not match %v -> %v", c.From, c.To)
	}
	total := 0
	for i := 1; i < len(c.Path); i++ {
		cost, ok := s.MoveCost(c.Path[i-1], c.Path[i])
		if !ok {
			return fmt.Errorf("gridmap: illegal move %v -> %v", c.Path[i-1], c.Path[i])
		}
		total += cost
	}
	if total != c.Dist {
		return fmt.Errorf("gridmap: path cost %d != certified distance %d", total, c.Dist)
	}
	return nil
}

type pqItem struct {
	cell  Coord
	dist  int
	index int
}

type priorityQueue []pqItem

func (q priorityQueue) Len() int            { return len(q) }
func (q priorityQueue) Less(i, j int) bool  { return q[i].dist < q[j].dist }
func (q priorityQueue) Swap(i, j int)       { q[i], q[j] = q[j], q[i]; q[i].index, q[j].index = i, j }
func (q *priorityQueue) Push(x interface{}) { *q = append(*q, x.(pqItem)) }
func (q *priorityQueue) Pop() interface{} {
	old := *q
	n := len(old)
	it := old[n-1]
	*q = old[:n-1]
	return it
}

// dijkstra computes dist(from, v) for every reachable cell v.
func dijkstra(s *Snapshot, from Coord) map[Coord]int {
	dist := map[Coord]int{from: 0}
	pq := &priorityQueue{{cell: from, dist: 0}}
	heap.Init(pq)
	for pq.Len() > 0 {
		it := heap.Pop(pq).(pqItem)
		if it.dist > dist[it.cell] {
			continue
		}
		for _, n := range s.Neighbors(it.cell) {
			nd := it.dist + n.Cost
			if cur, ok := dist[n.Cell]; !ok || nd < cur {
				dist[n.Cell] = nd
				heap.Push(pq, pqItem{cell: n.Cell, dist: nd})
			}
		}
	}
	return dist
}

// ShortestPath returns the minimum-cost path from from to to on snapshot
// s. Among all minimum-cost paths it returns the one whose coordinate
// sequence is lexicographically smallest (Coord.Less order). ok is false
// when from or to is blocked or no path exists.
func ShortestPath(s *Snapshot, from, to Coord) (path []Coord, dist int, ok bool) {
	if s.Blocked(from) || s.Blocked(to) {
		return nil, 0, false
	}
	// distTo[v] = dist(v, to); the graph is undirected so reverse = forward.
	distTo := dijkstra(s, to)
	d, ok := distTo[from]
	if !ok {
		return nil, 0, false
	}
	// Greedy lex-min reconstruction: at each cell, move to the smallest
	// neighbor (coordinate order) that still lies on some shortest path.
	// Lexicographic optimality is preserved because a smaller next cell
	// dominates any completion of a larger one.
	path = []Coord{from}
	cur := from
	remaining := d
	for cur != to {
		var best *struct {
			Cell Coord
			Cost int
		}
		for _, n := range s.Neighbors(cur) {
			if dn, ok := distTo[n.Cell]; ok && remaining-n.Cost == dn {
				if best == nil || n.Cell.Less(best.Cell) {
					nn := n
					best = &nn
				}
			}
		}
		if best == nil {
			return nil, 0, false // unreachable state; cannot happen after dijkstra
		}
		remaining -= best.Cost
		cur = best.Cell
		path = append(path, cur)
	}
	return path, d, true
}

// Distance returns only the shortest distance from from to to.
func Distance(s *Snapshot, from, to Coord) (dist int, ok bool) {
	if s.Blocked(from) || s.Blocked(to) {
		return 0, false
	}
	distTo := dijkstra(s, to)
	d, ok := distTo[from]
	return d, ok
}

// ShortestPathCertificate runs the shortest-path query and returns a
// certificate proving the result. ok is false only when from or to is
// blocked (no meaningful certificate); unreachability yields a valid
// certificate with Dist == -1.
func ShortestPathCertificate(s *Snapshot, from, to Coord) (cert *Certificate, ok bool) {
	if s.Blocked(from) || s.Blocked(to) {
		return nil, false
	}
	labels := dijkstra(s, from)
	cert = &Certificate{From: from, To: to, Labels: labels}
	d, reach := labels[to]
	if !reach {
		cert.Dist = -1
		return cert, true
	}
	cert.Dist = d
	path, pd, ok2 := ShortestPath(s, from, to)
	if !ok2 || pd != d {
		return nil, false // internal inconsistency; cannot happen
	}
	cert.Path = path
	return cert, true
}
