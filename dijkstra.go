package q159

import "container/heap"

// dNode is a settled Dijkstra result for one vertex.
type dNode struct {
	cost uint64
	seq  []EdgeID
	prev Edge
}

type pqItem struct {
	v    SchemaID
	cost uint64
	seq  []EdgeID
	prev Edge
	idx  int
}

type priorityQueue []*pqItem

func (pq priorityQueue) Len() int { return len(pq) }

func (pq priorityQueue) Less(i, j int) bool {
	if pq[i].cost != pq[j].cost {
		return pq[i].cost < pq[j].cost
	}
	return lessSeq(pq[i].seq, pq[j].seq)
}

func (pq priorityQueue) Swap(i, j int) {
	pq[i], pq[j] = pq[j], pq[i]
	pq[i].idx = i
	pq[j].idx = j
}

func (pq *priorityQueue) Push(x any) {
	item := x.(*pqItem)
	item.idx = len(*pq)
	*pq = append(*pq, item)
}

func (pq *priorityQueue) Pop() any {
	old := *pq
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	*pq = old[:n-1]
	return item
}

func lessSeq(a, b []EdgeID) bool {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func appendSeq(seq []EdgeID, id EdgeID) []EdgeID {
	out := make([]EdgeID, len(seq)+1)
	copy(out, seq)
	out[len(seq)] = id
	return out
}

// shortestPaths runs Dijkstra from src over positive-cost edges. When costs
// tie, the lexicographically smallest edge ID sequence wins, so the result
// is deterministic regardless of heap iteration order. Only reachable
// vertices appear in the returned map.
func (s *snapshot) shortestPaths(src SchemaID) map[SchemaID]dNode {
	pq := &priorityQueue{{v: src, cost: 0, seq: []EdgeID{}}}
	heap.Init(pq)

	best := make(map[SchemaID]*pqItem)
	best[src] = (*pq)[0]
	settled := make(map[SchemaID]dNode)

	for pq.Len() > 0 {
		item := heap.Pop(pq).(*pqItem)
		if _, done := settled[item.v]; done {
			continue
		}
		settled[item.v] = dNode{cost: item.cost, seq: item.seq, prev: item.prev}

		for _, edge := range s.adj[item.v] {
			if _, done := settled[edge.To]; done {
				continue
			}
			newCost := item.cost + edge.Cost
			newSeq := appendSeq(item.seq, edge.ID)
			old, known := best[edge.To]
			if !known || newCost < old.cost ||
				(newCost == old.cost && lessSeq(newSeq, old.seq)) {
				updated := &pqItem{
					v:    edge.To,
					cost: newCost,
					seq:  newSeq,
					prev: edge,
				}
				best[edge.To] = updated
				heap.Push(pq, updated)
			}
		}
	}
	return settled
}
