package recipe

import "sort"

// TopoOrder produces a deterministic topological ordering of the used
// ingredients that respects every precedence edge whose endpoints are
// both used. It is the legal processing-order certificate.
// Returns ok=false when the edges among used ingredients contain a cycle.
func TopoOrder(used []int, prec [][2]int) (order []int, ok bool) {
	inUse := make(map[int]bool, len(used))
	for _, i := range used {
		inUse[i] = true
	}
	indeg := make(map[int]int, len(used))
	adj := make(map[int][]int, len(used))
	for _, i := range used {
		indeg[i] = 0
	}
	for _, e := range prec {
		a, b := e[0], e[1]
		if !inUse[a] || !inUse[b] {
			continue
		}
		adj[a] = append(adj[a], b)
		indeg[b]++
	}
	// Deterministic Kahn: always take the smallest available index.
	var ready []int
	for _, i := range used {
		if indeg[i] == 0 {
			ready = append(ready, i)
		}
	}
	sort.Ints(ready)
	for len(ready) > 0 {
		v := ready[0]
		ready = ready[1:]
		order = append(order, v)
		next := append([]int(nil), adj[v]...)
		sort.Ints(next)
		for _, w := range next {
			indeg[w]--
			if indeg[w] == 0 {
				// insert keeping ready sorted
				pos := sort.SearchInts(ready, w)
				ready = append(ready, 0)
				copy(ready[pos+1:], ready[pos:])
				ready[pos] = w
			}
		}
	}
	if len(order) != len(used) {
		return nil, false
	}
	return order, true
}

// VerifyOrder independently checks that order is a valid processing
// certificate for the given quantities and precedence constraints:
// it must list exactly the used ingredients, each once, and respect
// every precedence edge among them.
func VerifyOrder(qty []int, prec [][2]int, order []int) bool {
	used := usedIndices(qty)
	if len(order) != len(used) {
		return false
	}
	pos := make(map[int]int, len(order))
	for rank, idx := range order {
		if idx < 0 || idx >= len(qty) || qty[idx] <= 0 {
			return false
		}
		if _, dup := pos[idx]; dup {
			return false
		}
		pos[idx] = rank
	}
	for _, i := range used {
		if _, present := pos[i]; !present {
			return false
		}
	}
	for _, e := range prec {
		a, b := e[0], e[1]
		pa, aUsed := pos[a]
		pb, bUsed := pos[b]
		if aUsed && bUsed && pa >= pb {
			return false
		}
	}
	return true
}
