package route

import "math"

// BBResult is the outcome of a budgeted branch-and-bound search.
type BBResult struct {
	Best           EvalResult // best feasible route found (valid if Found)
	Found          bool
	Optimal        bool // true when the search space was exhausted within budget
	LowerBound     int  // valid lower bound on the optimum paid cost
	Expansions     int  // DFS states expanded
	Budget         int  // expansion budget (<=0 means unlimited)
	BudgetExceeded bool
}

// BranchBound searches simple paths with branch-and-bound.
//
// The carried state tracks tolls paid, cumulative toll (capped), the visited
// set, rebate status and elapsed time. Fuel cost and the (mutually exclusive)
// coupon are not decided during the descent: both are computed exactly by
// EvalPath on complete paths. The lower bound of a partial path is therefore
// paidSoFar minus the still-redeemable rebate and the best coupon discount
// (fuel and future tolls are optimistically zero). That bound is monotone
// along any root-to-leaf path, so the minimum bound over the unexplored
// frontier remains valid when the budget cuts the search short.
func (n *Network) BranchBound(budget int) BBResult {
	start, _ := n.NodeIndex(n.Start)
	end, _ := n.NodeIndex(n.End)
	threshold, amount, hasRebate := n.RebateInfo()

	maxCoupon := 0
	for _, c := range n.Coupons {
		if c.Discount > maxCoupon {
			maxCoupon = c.Discount
		}
	}

	res := BBResult{Budget: budget, LowerBound: math.MaxInt32}
	frontier := math.MaxInt32
	cut := false
	note := func(lb int) {
		if lb < frontier {
			frontier = lb
		}
	}

	var dfs func(v int, visited uint16, cum int, rebateDone bool, paid, tm int, path []int)
	dfs = func(v int, visited uint16, cum int, rebateDone bool, paid, tm int, path []int) {
		lb := paid - maxCoupon
		if hasRebate && !rebateDone {
			lb -= amount
		}
		if cut {
			note(lb)
			return
		}
		if res.Expansions++; budget > 0 && res.Expansions > budget {
			cut = true
			res.BudgetExceeded = true
			note(lb)
			return
		}
		// bound: this subtree cannot improve the incumbent
		if res.Found && !better(lb, tm, res.Best.Paid, res.Best.Time) {
			return
		}
		if v == end {
			r := n.EvalPath(path)
			if r.OK && (!res.Found || better(r.Paid, r.Time, res.Best.Paid, res.Best.Time)) {
				res.Best, res.Found = r, true
			}
			return
		}
		for _, ei := range n.OutEdges(v) {
			e := n.Edges[ei]
			_, to := n.EdgeEndpoints(ei)
			if visited&(1<<uint(to)) != 0 {
				continue
			}
			ncum := cum + e.Toll
			nreb, npaid := rebateDone, paid+e.Toll
			if hasRebate && !nreb && ncum >= threshold && n.IsStation(to) {
				nreb = true
				npaid -= amount
			}
			if hasRebate && ncum > threshold {
				ncum = threshold
			}
			dfs(to, visited|1<<uint(to), ncum, nreb, npaid, tm+e.Time, append(path, to))
			if cut {
				note(lb)
				return
			}
		}
	}
	dfs(start, 1<<uint(start), 0, false, 0, 0, []int{start})

	if !res.BudgetExceeded {
		res.Optimal = true
		if res.Found {
			res.LowerBound = res.Best.Paid
		} else {
			res.LowerBound = 0 // no feasible route; bound is vacuous
		}
	} else {
		if frontier == math.MaxInt32 {
			frontier = 0
		}
		res.LowerBound = frontier
		if res.Found && res.Best.Paid < res.LowerBound {
			res.LowerBound = res.Best.Paid
		}
	}
	return res
}
