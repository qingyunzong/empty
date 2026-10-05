package transport

import "math"

// EnumResult summarizes a full enumeration of all assignments.
type EnumResult struct {
	// Total is the number of assignments examined (lines^orders).
	Total int
	// Feasible is the number of assignments satisfying both scenarios.
	Feasible int
	// Best is the optimal minimax objective among feasible
	// assignments, or +Inf if none is feasible.
	Best float64
	// BestAssignment is one optimal feasible assignment, nil if none.
	BestAssignment Assignment
}

// Enumerate checks every possible fixed assignment (orders are
// indivisible, so there are len(Lines)^len(Orders) of them) and returns
// the optimum. It is the ground-truth oracle used to verify Solve on
// small instances.
func Enumerate(p *Problem) (*EnumResult, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	res := &EnumResult{Best: math.Inf(1)}
	a := make(Assignment, len(p.Orders))
	var rec func(i int)
	rec = func(i int) {
		if i == len(p.Orders) {
			res.Total++
			if !p.Feasible(a) {
				return
			}
			res.Feasible++
			if obj := p.Objective(a); obj < res.Best {
				res.Best = obj
				res.BestAssignment = append(Assignment(nil), a...)
			}
			return
		}
		for j := range p.Lines {
			a[i] = j
			rec(i + 1)
		}
	}
	rec(0)
	return res, nil
}
