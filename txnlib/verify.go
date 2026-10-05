package txnlib

import "sort"

// VerifySerializable independently re-derives the full serialization
// graph of an accepted history from the transactions' recorded read
// predicates and write sets (ignoring any edges the store cached), and
// checks that the graph admits a serial order.
//
// It returns one witnessing serial order (a topological ordering of the
// transaction IDs) and true when the history is serializable, or nil
// and false when a cycle makes serializability impossible.
func VerifySerializable(history []*Txn) ([]int, bool) {
	edges := DeriveEdges(history)
	return topoSort(history, edges)
}

// DeriveEdges recomputes every dependency edge among the given
// transactions from scratch, ordering each pair by commit-request
// sequence. It does not consult Store state.
func DeriveEdges(history []*Txn) []Edge {
	sorted := make([]*Txn, len(history))
	copy(sorted, history)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].CommitSeq < sorted[j].CommitSeq })

	var edges []Edge
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			edges = append(edges, edgesBetween(sorted[i], sorted[j])...)
		}
	}
	return edges
}

// topoSort runs Kahn's algorithm over the transaction IDs.
func topoSort(history []*Txn, edges []Edge) ([]int, bool) {
	indeg := map[int]int{}
	adj := map[int]map[int]bool{}
	ids := map[int]bool{}
	for _, t := range history {
		indeg[t.ID] = 0
		ids[t.ID] = true
	}
	for _, e := range edges {
		if !ids[e.From] || !ids[e.To] || e.From == e.To {
			continue
		}
		if adj[e.From] == nil {
			adj[e.From] = map[int]bool{}
		}
		if !adj[e.From][e.To] {
			adj[e.From][e.To] = true
			indeg[e.To]++
		}
	}
	var ready []int
	for id, d := range indeg {
		if d == 0 {
			ready = append(ready, id)
		}
	}
	sort.Ints(ready)

	var order []int
	for len(ready) > 0 {
		n := ready[0]
		ready = ready[1:]
		order = append(order, n)
		var next []int
		for m := range adj[n] {
			indeg[m]--
			if indeg[m] == 0 {
				next = append(next, m)
			}
		}
		sort.Ints(next)
		ready = append(ready, next...)
	}
	if len(order) != len(history) {
		return nil, false
	}
	return order, true
}
