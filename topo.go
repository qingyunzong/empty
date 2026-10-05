package recipe

// TopoOrder computes a processing order (topological sort) of the used
// ingredients under the precedence constraints induced by counts.
// It returns the order and true, or false if the induced relation has a
// cycle (no legal processing order exists). Ties break by ingredient
// index for determinism.
func (in *Instance) TopoOrder(counts []int) ([]int, bool) {
	n := len(in.Ingredients)
	used := make([]bool, n)
	numUsed := 0
	for i, c := range counts {
		if c > 0 {
			used[i] = true
			numUsed++
		}
	}
	indeg := make([]int, n)
	adj := make([][]int, n)
	for _, e := range in.Precedence {
		a, b := e[0], e[1]
		if used[a] && used[b] {
			adj[a] = append(adj[a], b)
			indeg[b]++
		}
	}
	done := make([]bool, n)
	order := make([]int, 0, numUsed)
	for len(order) < numUsed {
		pick := -1
		for i := 0; i < n; i++ {
			if used[i] && !done[i] && indeg[i] == 0 {
				pick = i
				break
			}
		}
		if pick < 0 {
			return nil, false
		}
		done[pick] = true
		order = append(order, pick)
		for _, j := range adj[pick] {
			indeg[j]--
		}
	}
	return order, true
}

// VerifyOrder is the certificate checker: it confirms that order is
// exactly the set of used ingredients and that every precedence edge
// among used ingredients appears in the right sequence.
func (in *Instance) VerifyOrder(counts, order []int) bool {
	n := len(in.Ingredients)
	pos := make([]int, n)
	seen := make([]bool, n)
	for i := range pos {
		pos[i] = -1
	}
	for p, idx := range order {
		if idx < 0 || idx >= n || seen[idx] {
			return false
		}
		if counts[idx] <= 0 {
			return false
		}
		seen[idx] = true
		pos[idx] = p
	}
	for i, c := range counts {
		if c > 0 && !seen[i] {
			return false
		}
	}
	for _, e := range in.Precedence {
		a, b := e[0], e[1]
		if counts[a] > 0 && counts[b] > 0 && pos[a] >= pos[b] {
			return false
		}
	}
	return true
}
