package gridmap

import "container/heap"

// Result is the outcome of a successful ShortestPath query.
type Result struct {
	Path []Point // lexicographically smallest minimum-cost coordinate sequence
	Dist int     // total integer cost of Path
	Cert *Certificate
}

// ShortestPath finds a minimum-cost path from s to t. Among all
// minimum-cost paths it returns the one whose full coordinate sequence is
// lexicographically smallest (Points ordered by X, then Y). It also returns
// a Certificate proving the distance. ok is false when s or t is not free
// or no path exists.
func (m *Map) ShortestPath(s, t Point) (res Result, ok bool) {
	if !m.Free(s) || !m.Free(t) {
		return Result{}, false
	}
	dist := m.distancesTo(t)
	d := dist[s]
	if d < 0 {
		return Result{}, false
	}
	path := []Point{s}
	if s != t {
		cur, acc := s, 0
		for cur != t {
			var best Point
			bestCost, found := 0, false
			m.forEachNeighbor(cur, func(q Point, c int) {
				if dist[q] >= 0 && acc+c+dist[q] == d && (!found || q.Less(best)) {
					best, bestCost, found = q, c, true
				}
			})
			if !found { // unreachable state; indicates a bug
				return Result{}, false
			}
			acc += bestCost
			path = append(path, best)
			cur = best
		}
	}
	return Result{Path: path, Dist: d, Cert: &Certificate{
		Start:  s,
		Goal:   t,
		Dist:   d,
		Path:   path,
		Labels: dist,
	}}, true
}

// distancesTo runs Dijkstra backwards from goal over the (symmetric)
// movement graph and returns the distance from every reachable cell to
// goal. Unreachable cells are absent from the map.
func (m *Map) distancesTo(goal Point) map[Point]int {
	dist := map[Point]int{goal: 0}
	pq := &pqItemHeap{{p: goal, d: 0}}
	for pq.Len() > 0 {
		it := heap.Pop(pq).(pqItem)
		if it.d > dist[it.p] {
			continue
		}
		m.forEachNeighbor(it.p, func(q Point, c int) {
			nd := it.d + c
			if old, seen := dist[q]; !seen || nd < old {
				dist[q] = nd
				heap.Push(pq, pqItem{p: q, d: nd})
			}
		})
	}
	return dist
}

type pqItem struct {
	p Point
	d int
}

type pqItemHeap []pqItem

func (h pqItemHeap) Len() int            { return len(h) }
func (h pqItemHeap) Less(i, j int) bool  { return h[i].d < h[j].d }
func (h pqItemHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *pqItemHeap) Push(x interface{}) { *h = append(*h, x.(pqItem)) }
func (h *pqItemHeap) Pop() interface{} {
	old := *h
	n := len(old)
	it := old[n-1]
	*h = old[:n-1]
	return it
}
