package route

// Finite-state search over the expanded state graph.
//
// A state is (node, fuel, cumTollCapped, visitedMask, edgeMask, rebateDone,
// coupon). Every dimension is monotone (visited/edge masks only grow,
// cumulative toll is capped at the rebate threshold, flags only flip on, fuel
// only moves via priced refuel or edge consumption), so the state graph is
// finite and label-correcting relaxation terminates. Rebate and coupon
// effects are state transitions conditioned on accumulated path state --
// never standalone negative edges in the road graph.

type fsState struct {
	node       int
	fuel       int
	cum        int // cumulative toll, capped at rebate threshold
	visited    uint16
	edges      uint64
	rebateDone bool
	coupon     int // -1 none, else coupon index (mutually exclusive)
}

type fsLabel struct {
	paid, time int
}

// StateSearch solves the instance exactly over the finite state graph and
// returns the winning path evaluated by EvalPath, so its cost is directly
// comparable with simple-path enumeration.
func (n *Network) StateSearch() (EvalResult, bool) {
	start, _ := n.NodeIndex(n.Start)
	end, _ := n.NodeIndex(n.End)
	threshold, amount, hasRebate := n.RebateInfo()
	cap := n.Fuel.Capacity

	labels := map[fsState]fsLabel{}
	parent := map[fsState]fsState{}
	viaEdge := map[fsState]int{} // driving edge used to reach state, -1 otherwise
	s0 := fsState{node: start, fuel: n.Fuel.Start, visited: 1 << uint(start), coupon: -1}
	labels[s0] = fsLabel{}
	viaEdge[s0] = -1

	stack := []fsState{s0}
	inStack := map[fsState]bool{s0: true}
	relax := func(from, to fsState, addPaid, addTime, via int) {
		cand := fsLabel{labels[from].paid + addPaid, labels[from].time + addTime}
		cur, seen := labels[to]
		if !seen || better(cand.paid, cand.time, cur.paid, cur.time) {
			labels[to] = cand
			parent[to] = from
			viaEdge[to] = via
			if !inStack[to] {
				stack = append(stack, to)
				inStack[to] = true
			}
		}
	}
	for len(stack) > 0 {
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		inStack[s] = false
		// refuel one unit at a time (priced, monotone in fuel)
		if price, okP := n.FuelPriceAt(s.node); okP && s.fuel < cap {
			t := s
			t.fuel++
			relax(s, t, price, 0, -1)
		}
		// redeem the rebate at a designated station once qualified
		if hasRebate && !s.rebateDone && s.cum >= threshold && n.IsStation(s.node) {
			t := s
			t.rebateDone = true
			relax(s, t, -amount, 0, -1)
		}
		// apply a coupon once eligible (mutually exclusive)
		if s.coupon < 0 {
			for ci, c := range n.Coupons {
				if n.couponReq[ci]&^s.edges == 0 {
					t := s
					t.coupon = ci
					relax(s, t, -c.Discount, 0, -1)
				}
			}
		}
		// drive an edge
		for _, ei := range n.OutEdges(s.node) {
			e := n.Edges[ei]
			_, to := n.EdgeEndpoints(ei)
			if s.visited&(1<<uint(to)) != 0 || s.fuel < e.Dist {
				continue
			}
			t := fsState{
				node: to, fuel: s.fuel - e.Dist,
				visited: s.visited | 1<<uint(to),
				edges:   s.edges | 1<<uint(ei),
				coupon:  s.coupon, rebateDone: s.rebateDone,
			}
			t.cum = s.cum + e.Toll
			if hasRebate && t.cum > threshold {
				t.cum = threshold
			}
			relax(s, t, e.Toll, e.Time, ei)
		}
	}
	var bestL fsLabel
	var bestS fsState
	found := false
	for s, l := range labels {
		if s.node == end && (!found || better(l.paid, l.time, bestL.paid, bestL.time)) {
			bestL, bestS, found = l, s, true
		}
	}
	if !found {
		return EvalResult{}, false
	}
	// recover the node path from driving edges on the parent chain
	var rev []int
	for s := bestS; ; s = parent[s] {
		if viaEdge[s] >= 0 {
			rev = append(rev, s.node)
		}
		if s == s0 {
			break
		}
	}
	rev = append(rev, start)
	path := make([]int, len(rev))
	for i, v := range rev {
		path[len(rev)-1-i] = v
	}
	res := n.EvalPath(path)
	if !res.OK || res.Paid != bestL.paid || res.Time != bestL.time {
		// state graph and evaluator disagree: surface as not-ok rather than lie
		return EvalResult{Reason: "state search / evaluator mismatch"}, false
	}
	return res, true
}
