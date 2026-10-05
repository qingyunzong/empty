package cfglib

// This file is an independent, deliberately naive implementation of
// dominator queries based on the node-deletion reachability definition:
// d dominates n iff n is reachable from the entry and removing d makes n
// unreachable. It shares no code with the dominator-tree machinery in
// dom.go and exists to cross-check it, which is practical on small graphs.

// reachableWithout returns the nodes reachable from the entry when the
// node blocked (empty string for none) is removed from the graph.
func reachableWithout(g *Graph, blocked string) map[string]bool {
	seen := make(map[string]bool)
	if g.Entry() == blocked || !g.HasNode(g.Entry()) {
		return seen
	}
	stack := []string{g.Entry()}
	seen[g.Entry()] = true
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, s := range g.Successors(n) {
			if s == blocked || seen[s] {
				continue
			}
			seen[s] = true
			stack = append(stack, s)
		}
	}
	return seen
}

// NaiveDominators computes, for every reachable node, its full dominator
// set by the node-deletion reachability definition.
func NaiveDominators(g *Graph) map[string]map[string]bool {
	all := reachableWithout(g, "")
	res := make(map[string]map[string]bool)
	for _, n := range g.Nodes() {
		if !all[n] {
			continue
		}
		res[n] = make(map[string]bool)
		for _, d := range g.Nodes() {
			if !all[d] {
				continue
			}
			if d == n || !reachableWithout(g, d)[n] {
				res[n][d] = true
			}
		}
	}
	return res
}

// NaiveDominanceFrontier derives dominance frontiers from naive dominator
// sets: n is in DF(x) iff x dominates some reachable predecessor of n and
// x does not strictly dominate n.
func NaiveDominanceFrontier(g *Graph) map[string]map[string]bool {
	doms := NaiveDominators(g)
	df := make(map[string]map[string]bool)
	for x := range doms {
		df[x] = make(map[string]bool)
	}
	for n := range doms {
		for _, p := range g.Predecessors(n) {
			pdoms, ok := doms[p]
			if !ok {
				continue
			}
			for x := range pdoms {
				if x != n && doms[n][x] {
					continue // x strictly dominates n
				}
				df[x][n] = true
			}
		}
	}
	return df
}

// NaiveNearestCommonDominator returns the deepest common dominator of x
// and y according to naive dominator sets, and false when either node is
// unreachable.
func NaiveNearestCommonDominator(g *Graph, x, y string) (string, bool) {
	doms := NaiveDominators(g)
	dx, okx := doms[x]
	dy, oky := doms[y]
	if !okx || !oky {
		return "", false
	}
	best := ""
	bestSize := -1
	for c := range dx {
		if !dy[c] {
			continue
		}
		// The nearest common dominator is dominated by every common
		// dominator, hence has the largest dominator set among them.
		if len(doms[c]) > bestSize {
			best, bestSize = c, len(doms[c])
		}
	}
	return best, best != ""
}
