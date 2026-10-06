package main

import "sort"

// maximalCliques returns all maximal cliques of the conflict graph
// (Bron-Kerbosch with pivoting). n must be <= 64.
func maximalCliques(adj []uint64) []uint64 {
	var cliques []uint64
	all := uint64(0)
	for i := range adj {
		all |= 1 << i
	}
	var bk func(r, p, x uint64)
	bk = func(r, p, x uint64) {
		if p == 0 && x == 0 {
			cliques = append(cliques, r)
			return
		}
		// Pivot: vertex in p|x with the most neighbors in p.
		px := p | x
		pivot := -1
		best := -1
		for v := 0; v < len(adj); v++ {
			if px&(1<<v) != 0 {
				if c := popcount(adj[v] & p); c > best {
					best, pivot = c, v
				}
			}
		}
		cand := p
		if pivot >= 0 {
			cand = p &^ adj[pivot]
		}
		for v := 0; v < len(adj); v++ {
			if cand&(1<<v) == 0 {
				continue
			}
			bk(r|(1<<v), p&adj[v], x&adj[v])
			p &^= 1 << v
			x |= 1 << v
			cand &^= 1 << v
		}
	}
	bk(0, all, 0)
	return cliques
}

func popcount(m uint64) int {
	c := 0
	for m != 0 {
		m &= m - 1
		c++
	}
	return c
}

// Solve finds a minimum-cost integer green allocation and a feasible slot
// schedule. It returns the allocation, the schedule, and the total cost.
// ok is false when no feasible allocation exists.
func Solve(inst *Instance) (alloc []int, slots []uint64, total int, ok bool) {
	n := len(inst.Phases)
	adj := inst.adjacency()
	cliques := maximalCliques(adj)

	// cliquesOf[i] lists clique indices containing phase i.
	cliquesOf := make([][]int, n)
	for ci, c := range cliques {
		for v := 0; v < n; v++ {
			if c&(1<<v) != 0 {
				cliquesOf[v] = append(cliquesOf[v], ci)
			}
		}
	}

	// minCostCap[i][cap] = minimum cost of phase i over g in [min_i, cap].
	// Used for capacity-aware lower bounds during the search.
	minCostCap := make([][]int, n)
	for i := 0; i < n; i++ {
		minCostCap[i] = make([]int, inst.Cycle+1)
		best := -1
		for g := 0; g <= inst.Cycle; g++ {
			if g >= inst.Phases[i].Min {
				if c := inst.CostOf(i, g); best < 0 || c < best {
					best = c
				}
			}
			minCostCap[i][g] = best
		}
	}

	// Domain of each phase sorted by ascending cost for good incumbents.
	type val struct {
		g, c int
	}
	domains := make([][]val, n)
	for i := 0; i < n; i++ {
		for g := inst.Phases[i].Min; g <= inst.Cycle; g++ {
			domains[i] = append(domains[i], val{g, inst.CostOf(i, g)})
		}
		sort.Slice(domains[i], func(a, b int) bool {
			if domains[i][a].c != domains[i][b].c {
				return domains[i][a].c < domains[i][b].c
			}
			return domains[i][a].g > domains[i][b].g
		})
	}

	// Order phases by most constrained first (largest min, then degree).
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		pa, pb := inst.Phases[order[a]], inst.Phases[order[b]]
		if pa.Min != pb.Min {
			return pa.Min > pb.Min
		}
		return popcount(adj[order[a]]) > popcount(adj[order[b]])
	})

	residual := make([]int, len(cliques))
	for i := range residual {
		residual[i] = inst.Cycle
	}
	cur := make([]int, n)
	bestAlloc := make([]int, n)
	bestTotal := -1

	// lowerBound sums, over search positions k..n-1, each phase's minimum
	// cost given the current clique residual capacities.
	lowerBound := func(k int) int {
		sum := 0
		for j := k; j < n; j++ {
			ph := order[j]
			cap := inst.Cycle
			for _, ci := range cliquesOf[ph] {
				if residual[ci] < cap {
					cap = residual[ci]
				}
			}
			if b := minCostCap[ph][cap]; b >= 0 {
				sum += b
			}
		}
		return sum
	}

	var dfs func(k, cost int)
	dfs = func(k, cost int) {
		if bestTotal >= 0 && cost+lowerBound(k) >= bestTotal {
			return
		}
		if k == n {
			slots := Schedule(inst, cur)
			if slots == nil {
				return
			}
			if bestTotal < 0 || cost < bestTotal {
				bestTotal = cost
				copy(bestAlloc, cur)
			}
			return
		}
		ph := order[k]
		for _, v := range domains[ph] {
			if bestTotal >= 0 && cost+v.c >= bestTotal {
				break // domain sorted by cost
			}
			fits := true
			for _, ci := range cliquesOf[ph] {
				if residual[ci] < v.g {
					fits = false
					break
				}
			}
			if !fits {
				continue
			}
			for _, ci := range cliquesOf[ph] {
				residual[ci] -= v.g
			}
			cur[ph] = v.g
			dfs(k+1, cost+v.c)
			for _, ci := range cliquesOf[ph] {
				residual[ci] += v.g
			}
		}
	}
	dfs(0, 0)

	if bestTotal < 0 {
		return nil, nil, 0, false
	}
	return bestAlloc, Schedule(inst, bestAlloc), bestTotal, true
}
