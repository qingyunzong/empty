package main

// Brute-force solver: enumerates every feasible placement and returns
// the minimum cost. Exponential; intended for tiny inputs and as the
// ground-truth oracle that cross-checks the flow-based solver.

// bruteForceCost returns the minimum feasible total cost and whether
// any feasible placement exists. The budget is applied as a filter.
func bruteForceCost(p *Problem, applyBudget bool) (int, bool) {
	nSh, nSit := len(p.Shards), len(p.Sites)
	// Per-shard candidate site sets: subsets of sites of size exactly
	// k with pairwise distinct failure domains. Extra replicas only
	// add cost (all costs >= 0), so exactly k is optimal.
	type cand struct {
		sites []int
		cost  int
	}
	cands := make([][]cand, nSh)
	for i, sh := range p.Shards {
		k := sh.Replicas
		var sets [][]int
		var pick func(start int, chosen []int, doms map[string]bool)
		pick = func(start int, chosen []int, doms map[string]bool) {
			if len(chosen) == k {
				cp := make([]int, k)
				copy(cp, chosen)
				sets = append(sets, cp)
				return
			}
			for j := start; j < nSit; j++ {
				d := p.Sites[j].Domain
				if doms[d] {
					continue
				}
				doms[d] = true
				pick(j+1, append(chosen, j), doms)
				delete(doms, d)
			}
		}
		pick(0, nil, map[string]bool{})
		for _, s := range sets {
			c := 0
			for _, j := range s {
				c += p.Sites[j].Cost
			}
			cands[i] = append(cands[i], cand{sites: s, cost: c})
		}
	}

	best := -1
	used := make([]int, nSit)
	var dfs func(i, cost int)
	dfs = func(i, cost int) {
		if best >= 0 && cost >= best {
			return
		}
		if i == nSh {
			if !applyBudget || cost <= p.Budget {
				best = cost
			}
			return
		}
		for _, c := range cands[i] {
			ok := true
			for _, j := range c.sites {
				if used[j]+1 > p.Sites[j].Capacity {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
			for _, j := range c.sites {
				used[j]++
			}
			dfs(i+1, cost+c.cost)
			for _, j := range c.sites {
				used[j]--
			}
		}
	}
	dfs(0, 0)
	return best, best >= 0
}
