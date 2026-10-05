package route

import "fmt"

// Step is the per-edge status of one traversed edge.
type Step struct {
	Edge           int   // edge id
	From, To       int   // endpoints
	Toll           int64 // gross toll
	Coupon         int   // applied coupon id, -1 if none
	CouponDiscount int64 // discount applied to this edge's toll
	NetToll        int64 // Toll - CouponDiscount
	CumNetToll     int64 // cumulative net toll after this edge
	RebateRedeemed int64 // rebate amount redeemed when arriving at To
	RefuelBought   int64 // fuel bought at From before departing
	RefuelCost     int64 // cost of that fuel
	FuelBefore     int64 // tank level before traversing (after refuel)
	FuelAfter      int64 // tank level after traversing
	CumCost        int64 // cumulative total cost after this edge
	CumTime        int64 // cumulative travel time after this edge
}

// Simulation is the exact cost process of one simple path.
type Simulation struct {
	OK             bool
	Reason         string // why infeasible, when !OK
	Path           []int  // edge ids
	Cost           int64  // net tolls - rebate + fuel cost
	Time           int64
	TollCost       int64 // sum of net tolls
	FuelCost       int64 // sum of refuel costs
	RebateRedeemed int64
	RebateTriggers bool // cumulative net toll reached the threshold
	CouponUsed     int  // coupon id applied, -1 if none
	CouponEdgePos  int  // path position of the discounted edge
	Steps          []Step
}

// Simulate evaluates a path (edge ids) exactly: it picks the best
// mutually-exclusive coupon application and the cheapest refueling plan,
// then returns the full per-edge cost process. The rebate is never
// modeled as a negative edge; it is applied to the cumulative state.
func (p *Problem) Simulate(path []int) Simulation {
	best := Simulation{OK: false, Reason: "no feasible coupon/fuel plan"}
	try := func(coupon, edgePos int) {
		sim := p.simulateWithCoupon(path, coupon, edgePos)
		if !sim.OK {
			return
		}
		if !best.OK || sim.Cost < best.Cost {
			best = sim
		}
	}
	try(-1, -1)
	for c := range p.Coupons {
		earnPos, earned := p.earnPosition(path, c)
		if !earned {
			continue
		}
		for pos := earnPos + 1; pos < len(path); pos++ {
			try(c, pos)
		}
	}
	return best
}

// earnPosition returns the path position at which coupon c becomes
// earned (the latest position among its required edges), or false.
func (p *Problem) earnPosition(path []int, c int) (int, bool) {
	pos := -1
	for _, req := range p.Coupons[c].RequiresEdges {
		found := -1
		for i, e := range path {
			if e == req {
				found = i
				break
			}
		}
		if found < 0 {
			return -1, false
		}
		if found > pos {
			pos = found
		}
	}
	return pos, true
}

// simulateWithCoupon evaluates the path with a fixed coupon decision
// (coupon applied to the edge at path position edgePos; -1/-1 = none).
func (p *Problem) simulateWithCoupon(path []int, coupon, edgePos int) Simulation {
	fail := func(reason string) Simulation {
		return Simulation{OK: false, Reason: reason, Path: path, CouponUsed: coupon, CouponEdgePos: edgePos}
	}
	if len(path) == 0 {
		return fail("empty path")
	}
	if len(path)+1 > p.MaxNodes {
		return fail(fmt.Sprintf("path uses %d nodes, limit is %d", len(path)+1, p.MaxNodes))
	}
	// Structural checks: contiguity, simplicity.
	nodes := make([]int, 0, len(path)+1)
	seen := make([]bool, p.NumNodes)
	cur := p.Edges[path[0]].From
	if cur != p.Start {
		return fail("path does not start at start node")
	}
	seen[cur] = true
	nodes = append(nodes, cur)
	for _, eid := range path {
		e := p.Edges[eid]
		if e.From != cur {
			return fail("path edges are not contiguous")
		}
		if seen[e.To] {
			return fail("path repeats a node")
		}
		seen[e.To] = true
		nodes = append(nodes, e.To)
		cur = e.To
	}
	if cur != p.End {
		return fail("path does not end at end node")
	}
	if coupon >= 0 {
		if coupon >= len(p.Coupons) {
			return fail("coupon id out of range")
		}
		earnPos, earned := p.earnPosition(path, coupon)
		if !earned {
			return fail("coupon requirements not met by path")
		}
		if edgePos <= earnPos || edgePos >= len(path) {
			return fail("coupon applied before being earned")
		}
	}

	// Optimal refueling plan for this fixed path (exact DP).
	fuelCost, buys, fuelOK := p.fuelPlan(path)
	if !fuelOK {
		return fail("fuel infeasible")
	}

	sim := Simulation{
		OK:            true,
		Path:          append([]int(nil), path...),
		CouponUsed:    coupon,
		CouponEdgePos: edgePos,
		FuelCost:      fuelCost,
	}
	var cumNet, cumCost, cumTime int64
	triggered := false
	redeemed := false
	redeemAt := func(node int, stepIdx int) {
		if !triggered || redeemed {
			return
		}
		if len(p.Rebate.Stations) == 0 || p.isRebateStation(node) {
			redeemed = true
			sim.RebateRedeemed = p.Rebate.Amount
			cumCost -= p.Rebate.Amount
			if stepIdx >= 0 {
				sim.Steps[stepIdx].RebateRedeemed = p.Rebate.Amount
				sim.Steps[stepIdx].CumCost = cumCost
			}
		}
	}
	// Degenerate threshold: triggered before any edge.
	if cumNet >= p.Rebate.Threshold {
		triggered = true
		redeemAt(nodes[0], -1)
	}
	fuel := p.Fuel.Start
	for j, eid := range path {
		e := p.Edges[eid]
		st := Step{Edge: eid, From: e.From, To: e.To, Toll: e.Toll, Coupon: -1}
		// Refuel at the departure node (position j).
		if p.fuelConstrained() && buys[j] > 0 {
			price, _ := p.fuelPriceAt(nodes[j])
			st.RefuelBought = buys[j]
			st.RefuelCost = buys[j] * price
			fuel += buys[j]
			cumCost += st.RefuelCost
		}
		// Coupon discount on this edge's toll.
		disc := int64(0)
		if j == edgePos && coupon >= 0 {
			disc = p.Coupons[coupon].Discount
			if disc > e.Toll {
				disc = e.Toll
			}
			st.Coupon = coupon
			st.CouponDiscount = disc
		}
		st.NetToll = e.Toll - disc
		cumNet += st.NetToll
		st.CumNetToll = cumNet
		cumCost += st.NetToll
		cumTime += e.Time
		if !triggered && cumNet >= p.Rebate.Threshold {
			triggered = true
		}
		if p.fuelConstrained() {
			st.FuelBefore = fuel
			fuel -= e.Fuel
			st.FuelAfter = fuel
		}
		st.CumCost = cumCost
		st.CumTime = cumTime
		sim.Steps = append(sim.Steps, st)
		redeemAt(nodes[j+1], j)
	}
	sim.TollCost = cumNet
	sim.Cost = cumCost
	sim.Time = cumTime
	sim.RebateTriggers = triggered
	return sim
}

// fuelPlan computes the minimum refueling cost for a fixed path via an
// exact DP over integer tank levels, and returns the buy plan per path
// position. ok=false means the path cannot be driven with the tank.
func (p *Problem) fuelPlan(path []int) (cost int64, buys []int64, ok bool) {
	k := len(path)
	buys = make([]int64, k)
	if !p.fuelConstrained() {
		return 0, buys, true
	}
	cap := p.Fuel.Capacity
	const inf = int64(1) << 62
	// arrive[i][f]: min refuel cost to arrive at position i with f fuel.
	arrive := make([][]int64, k+1)
	type parent struct {
		prevF int64
		buy   int64
	}
	par := make([][]parent, k+1)
	for i := range arrive {
		arrive[i] = make([]int64, cap+1)
		par[i] = make([]parent, cap+1)
		for f := range arrive[i] {
			arrive[i][f] = inf
		}
	}
	arrive[0][p.Fuel.Start] = 0
	for i := 0; i < k; i++ {
		price, isStation := p.fuelPriceAt(p.Edges[path[i]].From)
		need := p.Edges[path[i]].Fuel
		for f := int64(0); f <= cap; f++ {
			base := arrive[i][f]
			if base == inf {
				continue
			}
			maxBuy := int64(0)
			if isStation {
				maxBuy = cap - f
			}
			for b := int64(0); b <= maxBuy; b++ {
				nf := f + b
				if nf < need {
					continue
				}
				c := base + b*price
				after := nf - need
				if c < arrive[i+1][after] {
					arrive[i+1][after] = c
					par[i+1][after] = parent{prevF: f, buy: b}
				}
			}
		}
	}
	bestF := int64(-1)
	for f := int64(0); f <= cap; f++ {
		if arrive[k][f] != inf && (bestF < 0 || arrive[k][f] < arrive[k][bestF]) {
			bestF = f
		}
	}
	if bestF < 0 {
		return 0, nil, false
	}
	// Reconstruct buys per position.
	f := bestF
	for i := k; i >= 1; i-- {
		buys[i-1] = par[i][f].buy
		f = par[i][f].prevF
	}
	return arrive[k][bestF], buys, true
}
