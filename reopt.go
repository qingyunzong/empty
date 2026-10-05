package contractopt

import "fmt"

// ReoptResult describes the outcome of re-optimizing an instance after one
// contract was revised. The primary objective is the number of contracts
// whose assignment changed relative to the old one; among those solutions
// revenue is maximized, then total resource usage minimized.
type ReoptResult struct {
	Old map[string]int // previous assignment (copied from the input)
	New Solution       // re-optimized assignment

	Changes int // contracts whose selection status or start changed

	// Bound evidence.
	ChangesLowerBound int   // 0 if the old assignment is still feasible, else 1
	RevenueLowerBound int64 // achieved: New.Revenue
	RevenueUpperBound int64 // optimal revenue of the revised instance with no change limit
	SearchNodes       int   // branch-and-bound nodes explored
}

// Reoptimize solves the revised instance (in must already contain the revised
// contract) staying as close as possible to the old assignment: it minimizes
// the number of changed contracts, then maximizes revenue, then minimizes
// total resource usage. Locked contracts can never move.
func Reoptimize(in *Instance, old map[string]int) (ReoptResult, error) {
	if err := in.Validate(); err != nil {
		return ReoptResult{}, err
	}
	idx := in.index()
	for id := range old {
		if _, ok := idx[id]; !ok {
			return ReoptResult{}, fmt.Errorf("contractopt: old assignment references unknown contract %q", id)
		}
	}
	res := ReoptResult{Old: copyAssign(old)}
	if _, err := in.Evaluate(old); err == nil {
		res.ChangesLowerBound = 0
	} else {
		res.ChangesLowerBound = 1
	}
	// Upper bound evidence: the unconstrained optimum of the revised instance.
	ub, err := Solve(in)
	if err != nil {
		return ReoptResult{}, err
	}
	res.RevenueUpperBound = ub.Solution.Revenue

	r := newReoptSearch(in, old)
	r.run()
	if !r.hasBest {
		return ReoptResult{}, ErrInfeasible
	}
	res.New = Solution{Assign: r.best, Revenue: r.bestRev, Usage: r.bestUsage}
	res.Changes = r.bestChanges
	res.RevenueLowerBound = r.bestRev
	res.SearchNodes = r.nodes
	return res, nil
}

func copyAssign(a map[string]int) map[string]int {
	out := make(map[string]int, len(a))
	for k, v := range a {
		out[k] = v
	}
	return out
}

// reoptSearch is branch and bound lexicographic on (changes asc, revenue
// desc, usage asc).
type reoptSearch struct {
	in    *Instance
	old   map[string]int
	idx   map[string]int
	n     int
	used  [][]int64
	sel   []int
	dec   []bool
	group map[string]bool
	count int
	rev   int64
	usage int64
	chg   int

	suffix []int64

	best        map[string]int
	bestRev     int64
	bestUsage   int64
	bestChanges int
	hasBest     bool
	nodes       int
}

func newReoptSearch(in *Instance, old map[string]int) *reoptSearch {
	n := len(in.Contracts)
	r := &reoptSearch{
		in:    in,
		old:   old,
		idx:   in.index(),
		n:     n,
		sel:   make([]int, n),
		dec:   make([]bool, n),
		group: make(map[string]bool),
	}
	for i := range r.sel {
		r.sel[i] = -1
	}
	r.used = make([][]int64, in.Periods)
	for p := range r.used {
		r.used[p] = make([]int64, in.Resources)
	}
	r.suffix = make([]int64, n+1)
	for i := n - 1; i >= 0; i-- {
		r.suffix[i] = r.suffix[i+1]
		if v := in.Contracts[i].Revenue; v > 0 {
			r.suffix[i] += v
		}
	}
	return r
}

func (r *reoptSearch) run() { r.dfs(0) }

func (r *reoptSearch) boundTight(i int) bool {
	if !r.hasBest {
		return false
	}
	if r.chg > r.bestChanges {
		return true
	}
	if r.chg < r.bestChanges {
		return false
	}
	ub := r.rev + r.suffix[i]
	if ub < r.bestRev {
		return true
	}
	return ub == r.bestRev && r.usage >= r.bestUsage
}

func (r *reoptSearch) dfs(i int) {
	if r.boundTight(i) {
		return
	}
	r.nodes++
	if i == r.n {
		r.commit()
		return
	}
	c := &r.in.Contracts[i]
	if c.Locked {
		if r.canPlace(i, c.Start) {
			r.place(i, c.Start)
			r.dfs(i + 1)
			r.unplace(i, c.Start)
		}
		return
	}
	// Skip option: a change iff the contract was selected before.
	_, wasSel := r.old[c.ID]
	r.dec[i] = true
	if wasSel {
		r.chg++
	}
	r.dfs(i + 1)
	if wasSel {
		r.chg--
	}
	r.dec[i] = false
	// Select options: a change iff the start differs from the old one.
	for _, st := range c.Starts {
		if !r.canPlace(i, st) {
			continue
		}
		oldSt, had := r.old[c.ID]
		moved := !had || oldSt != st
		r.place(i, st)
		if moved {
			r.chg++
		}
		r.dfs(i + 1)
		if moved {
			r.chg--
		}
		r.unplace(i, st)
	}
}

func (r *reoptSearch) canPlace(i int, st int) bool {
	c := &r.in.Contracts[i]
	if r.count+1 > r.in.MaxSelect {
		return false
	}
	if c.Group != "" && r.group[c.Group] {
		return false
	}
	for _, qid := range c.Prereqs {
		j := r.idx[qid]
		if r.dec[j] {
			if r.sel[j] < 0 {
				return false
			}
			if r.sel[j]+r.in.Contracts[j].Duration > st {
				return false
			}
		}
	}
	for p := st; p < st+c.Duration; p++ {
		for rr := 0; rr < r.in.Resources; rr++ {
			if r.used[p][rr]+c.Demand[rr] > r.in.Capacity[p][rr] {
				return false
			}
		}
	}
	return true
}

func (r *reoptSearch) place(i int, st int) {
	c := &r.in.Contracts[i]
	r.dec[i] = true
	r.sel[i] = st
	r.count++
	r.rev += c.Revenue
	r.usage += contractUsage(c)
	if c.Group != "" {
		r.group[c.Group] = true
	}
	for p := st; p < st+c.Duration; p++ {
		for rr := 0; rr < r.in.Resources; rr++ {
			r.used[p][rr] += c.Demand[rr]
		}
	}
}

func (r *reoptSearch) unplace(i int, st int) {
	c := &r.in.Contracts[i]
	r.dec[i] = false
	r.sel[i] = -1
	r.count--
	r.rev -= c.Revenue
	r.usage -= contractUsage(c)
	if c.Group != "" {
		r.group[c.Group] = false
	}
	for p := st; p < st+c.Duration; p++ {
		for rr := 0; rr < r.in.Resources; rr++ {
			r.used[p][rr] -= c.Demand[rr]
		}
	}
}

func (r *reoptSearch) commit() {
	for i := 0; i < r.n; i++ {
		if r.sel[i] < 0 {
			continue
		}
		for _, qid := range r.in.Contracts[i].Prereqs {
			j := r.idx[qid]
			if r.sel[j] < 0 || r.sel[j]+r.in.Contracts[j].Duration > r.sel[i] {
				return
			}
		}
	}
	if !r.hasBest || r.less(r.chg, r.rev, r.usage, r.bestChanges, r.bestRev, r.bestUsage) {
		r.hasBest = true
		r.bestChanges = r.chg
		r.bestRev = r.rev
		r.bestUsage = r.usage
		r.best = make(map[string]int, r.count)
		for i := 0; i < r.n; i++ {
			if r.sel[i] >= 0 {
				r.best[r.in.Contracts[i].ID] = r.sel[i]
			}
		}
	}
}

// less compares (changes asc, revenue desc, usage asc).
func (r *reoptSearch) less(c1 int, rev1, u1 int64, c2 int, rev2, u2 int64) bool {
	if c1 != c2 {
		return c1 < c2
	}
	return better(rev1, u1, rev2, u2)
}

// EnumerateReopt is the brute-force counterpart of Reoptimize for small
// instances: it enumerates every feasible assignment and returns the
// lexicographic optimum on (changes, revenue, usage).
func EnumerateReopt(in *Instance, old map[string]int) (ReoptResult, error) {
	if err := in.Validate(); err != nil {
		return ReoptResult{}, err
	}
	r := newReoptSearch(in, old)
	r.exhaust(0)
	if !r.hasBest {
		return ReoptResult{}, ErrInfeasible
	}
	return ReoptResult{
		Old:     copyAssign(old),
		New:     Solution{Assign: r.best, Revenue: r.bestRev, Usage: r.bestUsage},
		Changes: r.bestChanges,
	}, nil
}

// exhaust explores the full tree without bound pruning.
func (r *reoptSearch) exhaust(i int) {
	if i == r.n {
		r.commit()
		return
	}
	c := &r.in.Contracts[i]
	if c.Locked {
		if r.canPlace(i, c.Start) {
			r.place(i, c.Start)
			r.exhaust(i + 1)
			r.unplace(i, c.Start)
		}
		return
	}
	_, wasSel := r.old[c.ID]
	r.dec[i] = true
	if wasSel {
		r.chg++
	}
	r.exhaust(i + 1)
	if wasSel {
		r.chg--
	}
	r.dec[i] = false
	for _, st := range c.Starts {
		if !r.canPlace(i, st) {
			continue
		}
		oldSt, had := r.old[c.ID]
		moved := !had || oldSt != st
		r.place(i, st)
		if moved {
			r.chg++
		}
		r.exhaust(i + 1)
		if moved {
			r.chg--
		}
		r.unplace(i, st)
	}
}
