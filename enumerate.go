package transport

// FrontierPoint is a feasible assignment together with its scenario costs.
type FrontierPoint struct {
	Cost       [Scenarios]int
	Assignment []int
}

// EnumResult summarizes a full enumeration of the assignment space.
type EnumResult struct {
	Total     int // total assignments examined (lines^orders)
	Feasible  int // assignments feasible in both scenarios
	Found     bool
	Best      []int // optimal assignment (minimax objective)
	BestCost  [Scenarios]int
	Objective int
	Frontier  []FrontierPoint // Pareto frontier in (scenario-0, scenario-1) cost space
}

// dominates reports whether cost a Pareto-dominates cost b.
func dominates(a, b [Scenarios]int) bool {
	le := true
	strict := false
	for s := 0; s < Scenarios; s++ {
		if a[s] > b[s] {
			le = false
		}
		if a[s] < b[s] {
			strict = true
		}
	}
	return le && strict
}

// addFrontier inserts a point into the frontier, dropping dominated entries.
func addFrontier(f []FrontierPoint, pt FrontierPoint) []FrontierPoint {
	out := f[:0]
	for _, q := range f {
		if dominates(q.Cost, pt.Cost) {
			return f // existing point dominates the new one
		}
		if !dominates(pt.Cost, q.Cost) {
			out = append(out, q)
		}
	}
	return append(out, pt)
}

// Enumerate evaluates every indivisible order-to-line assignment and returns
// the optimum, the Pareto frontier, and feasibility counts. It is the
// ground-truth verifier for the branch-and-bound solver.
func Enumerate(p *Problem) EnumResult {
	n, m := len(p.Orders), len(p.Lines)
	res := EnumResult{Objective: -1}
	a := make([]int, n)
	total := 1
	for i := 0; i < n; i++ {
		total *= m
	}
	res.Total = total
	for idx := 0; idx < total; idx++ {
		// Odometer: decode idx into a full assignment.
		for o, v := n-1, idx; o >= 0; o, v = o-1, v/m {
			a[o] = v % m
		}
		if !p.Feasible(a) {
			continue
		}
		res.Feasible++
		c := p.Costs(a)
		res.Frontier = addFrontier(res.Frontier, FrontierPoint{Cost: c, Assignment: append([]int(nil), a...)})
		if obj := Objective(c); res.Objective < 0 || obj < res.Objective {
			res.Objective = obj
			res.BestCost = c
			res.Best = append([]int(nil), a...)
			res.Found = true
		}
	}
	return res
}
