package signal

import "fmt"

// Exhaustive finds a minimum-cost schedule by enumerating every
// multiset of at most Cycle non-empty conflict-free sets. It is only
// practical for tiny cycles and serves as an independent optimality
// oracle for Solve. maxEnum bounds the number of enumerated multisets.
func Exhaustive(p *Problem, maxEnum int64) (*Certificate, error) {
	n := len(p.Phases)
	adj := p.adjacency()
	sets := independentSets(adj)
	k := len(sets)
	if total := binomCap(p.Cycle+k, k, maxEnum+1); total > maxEnum {
		return nil, fmt.Errorf("exhaustive search would enumerate %d multisets (limit %d); cycle too large", total, maxEnum)
	}

	counts := make([]int, k)
	green := make([]int, n)
	best := make([]int, k)
	bestCost := 0
	found := false

	var rec func(j, remaining int)
	rec = func(j, remaining int) {
		if j == k {
			for i := 0; i < n; i++ {
				if green[i] < p.Phases[i].Min {
					return
				}
			}
			c := 0
			for i := 0; i < n; i++ {
				c += p.Phases[i].Cost[green[i]]
			}
			if !found || c < bestCost {
				found, bestCost = true, c
				copy(best, counts)
			}
			return
		}
		mem := maskMembers(sets[j], n)
		for cnt := 0; cnt <= remaining; cnt++ {
			counts[j] = cnt
			for _, m := range mem {
				green[m] += cnt
			}
			rec(j+1, remaining-cnt)
			for _, m := range mem {
				green[m] -= cnt
			}
		}
		counts[j] = 0
	}
	rec(0, p.Cycle)
	if !found {
		return nil, ErrInfeasible
	}

	slots := make([][]int, 0, p.Cycle)
	for j := 0; j < k; j++ {
		for c := 0; c < best[j]; c++ {
			slots = append(slots, maskMembers(sets[j], n))
		}
	}
	for len(slots) < p.Cycle {
		slots = append(slots, []int{})
	}
	g := make([]int, n)
	for i := range g {
		for j := 0; j < k; j++ {
			if sets[j]&(1<<i) != 0 {
				g[i] += best[j]
			}
		}
	}
	return &Certificate{
		Cycle:   p.Cycle,
		Cost:    bestCost,
		Green:   g,
		Slots:   slots,
		Optimal: true,
		Method:  "exhaustive",
	}, nil
}

// binomCap returns C(n, k), stopping early and returning cap once the
// value would reach cap.
func binomCap(n, k int, cap int64) int64 {
	if k < 0 || n < k {
		return 0
	}
	if k > n-k {
		k = n - k
	}
	r := int64(1)
	for i := 1; i <= k; i++ {
		r = r * int64(n-k+i) / int64(i)
		if r >= cap {
			return cap
		}
	}
	return r
}
