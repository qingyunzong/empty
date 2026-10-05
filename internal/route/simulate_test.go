package route

import "testing"

// TestRebateCumulativeNotNegativeEdge: the rebate is a one-time event on
// the cumulative net toll, not a per-edge discount. Two edges of toll 6
// with threshold 10 and amount 10 give net cost 12-10=2, applied once.
func TestRebateCumulativeNotNegativeEdge(t *testing.T) {
	p := &Problem{
		NumNodes: 3, Start: 0, End: 2, MaxNodes: 12,
		Edges: []Edge{
			{From: 0, To: 1, Toll: 6, Time: 1},
			{From: 1, To: 2, Toll: 6, Time: 1},
		},
		Rebate: Rebate{Threshold: 10, Amount: 10},
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	sim := p.Simulate([]int{0, 1})
	if !sim.OK {
		t.Fatalf("infeasible: %s", sim.Reason)
	}
	if sim.Cost != 2 || sim.RebateRedeemed != 10 || !sim.RebateTriggers {
		t.Fatalf("cost=%d redeemed=%d, want cost=2 redeemed=10", sim.Cost, sim.RebateRedeemed)
	}
	// Rebate redeemed exactly once, on the edge that crosses 10.
	if sim.Steps[0].RebateRedeemed != 0 || sim.Steps[1].RebateRedeemed != 10 {
		t.Fatalf("rebate steps wrong: %+v", sim.Steps)
	}
	if sim.Steps[0].CumCost != 6 || sim.Steps[1].CumCost != 2 {
		t.Fatalf("cumulative cost process wrong: %+v", sim.Steps)
	}
}

// TestRebateOnlyAtStations: with designated stations, the rebate is
// redeemed only when the path arrives at one of them after triggering.
func TestRebateOnlyAtStations(t *testing.T) {
	base := func() *Problem {
		return &Problem{
			NumNodes: 4, Start: 0, End: 3, MaxNodes: 12,
			Edges: []Edge{
				{From: 0, To: 1, Toll: 6, Time: 1},  // 0
				{From: 1, To: 2, Toll: 6, Time: 1},  // 1
				{From: 2, To: 3, Toll: 1, Time: 1},  // 2
				{From: 0, To: 2, Toll: 11, Time: 5}, // 3
			},
			Rebate: Rebate{Threshold: 10, Amount: 10, Stations: []int{1}},
		}
	}
	p := base()
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	// Path 0->1->2->3 triggers at node 2 (cum 12), but node 2 is not a
	// station and node 1 was passed before triggering: no redemption.
	sim := p.Simulate([]int{0, 1, 2})
	if !sim.OK || sim.Cost != 13 || sim.RebateRedeemed != 0 {
		t.Fatalf("via-1: cost=%d redeemed=%d, want 13/0", sim.Cost, sim.RebateRedeemed)
	}
	// Direct 0->2 triggers at node 2, not a station: no redemption.
	sim = p.Simulate([]int{3, 2})
	if !sim.OK || sim.Cost != 12 {
		t.Fatalf("direct: cost=%d, want 12", sim.Cost)
	}
	// With node 2 designated, both redeem.
	p.Rebate.Stations = []int{2}
	sim = p.Simulate([]int{0, 1, 2})
	if !sim.OK || sim.Cost != 3 || sim.Steps[1].RebateRedeemed != 10 {
		t.Fatalf("station=2 via-1: cost=%d, want 3", sim.Cost)
	}
	res := p.Search(0)
	if !res.Found || res.Cost != 2 { // direct 0->2->3: 12-10=2
		t.Fatalf("search cost=%d, want 2", res.Cost)
	}
}

// TestCouponMutuallyExclusive: two earned coupons, at most one applied.
func TestCouponMutuallyExclusive(t *testing.T) {
	p := &Problem{
		NumNodes: 3, Start: 0, End: 2, MaxNodes: 12,
		Edges: []Edge{
			{From: 0, To: 1, Toll: 4, Time: 1},  // 0
			{From: 1, To: 2, Toll: 20, Time: 1}, // 1
		},
		Coupons: []Coupon{
			{RequiresEdges: []int{0}, Discount: 5},
			{RequiresEdges: []int{0}, Discount: 8},
		},
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	sim := p.Simulate([]int{0, 1})
	// Best single coupon is 8 on edge 1: 4+20-8=16, not 24-5-8=11.
	if !sim.OK || sim.Cost != 16 || sim.CouponUsed != 1 {
		t.Fatalf("cost=%d coupon=%d, want 16/1", sim.Cost, sim.CouponUsed)
	}
}

// TestCouponRequiresTraveledEdges: a coupon is earned only after all of
// its required edges have been traveled, and applies only later.
func TestCouponRequiresTraveledEdges(t *testing.T) {
	p := &Problem{
		NumNodes: 4, Start: 0, End: 3, MaxNodes: 12,
		Edges: []Edge{
			{From: 0, To: 1, Toll: 2, Time: 1},  // 0
			{From: 1, To: 2, Toll: 2, Time: 1},  // 1
			{From: 2, To: 3, Toll: 9, Time: 1},  // 2
			{From: 0, To: 3, Toll: 20, Time: 1}, // 3
		},
		Coupons: []Coupon{
			{RequiresEdges: []int{0, 1}, Discount: 7}, // needs edges 0 and 1
		},
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	// Direct edge 3 never travels edges 0,1: coupon not earned.
	sim := p.Simulate([]int{3})
	if !sim.OK || sim.Cost != 20 || sim.CouponUsed != -1 {
		t.Fatalf("direct: cost=%d coupon=%d, want 20/-1", sim.Cost, sim.CouponUsed)
	}
	// Via 0,1: coupon earned after edge 1, applies to edge 2: 2+2+9-7=6.
	sim = p.Simulate([]int{0, 1, 2})
	if !sim.OK || sim.Cost != 6 || sim.CouponUsed != 0 || sim.CouponEdgePos != 2 {
		t.Fatalf("via: cost=%d coupon=%d pos=%d, want 6/0/2",
			sim.Cost, sim.CouponUsed, sim.CouponEdgePos)
	}
	res := p.Search(0)
	if !res.Found || res.Cost != 6 {
		t.Fatalf("search cost=%d, want 6", res.Cost)
	}
}

// TestFuelAndRefuelCost: fuel capacity and refueling cost are exact.
func TestFuelAndRefuelCost(t *testing.T) {
	p := &Problem{
		NumNodes: 3, Start: 0, End: 2, MaxNodes: 12,
		Edges: []Edge{
			{From: 0, To: 1, Toll: 1, Time: 1, Fuel: 3}, // 0
			{From: 1, To: 2, Toll: 1, Time: 1, Fuel: 2}, // 1
		},
		Fuel: Fuel{
			Capacity: 5, Start: 2,
			Stations: []FuelStation{{Node: 0, Price: 4}, {Node: 1, Price: 9}},
		},
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	sim := p.Simulate([]int{0, 1})
	// Need 5 fuel total, start 2: buy 3 at node 0 (price 4) = 12.
	// Tolls 2, fuel 12 -> 14.
	if !sim.OK || sim.Cost != 14 || sim.FuelCost != 12 {
		t.Fatalf("cost=%d fuel=%d, want 14/12", sim.Cost, sim.FuelCost)
	}
	if sim.Steps[0].RefuelBought != 3 || sim.Steps[0].RefuelCost != 12 ||
		sim.Steps[0].FuelBefore != 5 || sim.Steps[0].FuelAfter != 2 {
		t.Fatalf("step0 fuel status wrong: %+v", sim.Steps[0])
	}
	if sim.Steps[1].RefuelBought != 0 || sim.Steps[1].FuelBefore != 2 {
		t.Fatalf("step1 fuel status wrong: %+v", sim.Steps[1])
	}
	// Cheaper to buy at node 0 (4) than node 1 (9): plan must prefer it.
	res := p.Search(0)
	if !res.Found || res.Cost != 14 {
		t.Fatalf("search cost=%d, want 14", res.Cost)
	}
	// Without any fuel station the path is infeasible.
	p.Fuel.Stations = nil
	sim = p.Simulate([]int{0, 1})
	if sim.OK {
		t.Fatalf("expected fuel infeasible, got cost %d", sim.Cost)
	}
	if p.Search(0).Found || p.Enumerate().Found {
		t.Fatal("expected no feasible route without fuel stations")
	}
}

// TestCostThenTimeOrdering: primary key is paid cost, then travel time.
func TestCostThenTimeOrdering(t *testing.T) {
	p := &Problem{
		NumNodes: 3, Start: 0, End: 2, MaxNodes: 12,
		Edges: []Edge{
			{From: 0, To: 2, Toll: 10, Time: 50}, // 0: cheap but slow
			{From: 0, To: 1, Toll: 5, Time: 1},   // 1
			{From: 1, To: 2, Toll: 5, Time: 1},   // 2: same cost, fast
			{From: 0, To: 2, Toll: 9, Time: 99},  // 3: cheaper, slower
		},
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	res := p.Search(0)
	// Cheapest cost is 9 (edge 3) despite time 99.
	if !res.Found || res.Cost != 9 || res.Time != 99 {
		t.Fatalf("cost=%d time=%d, want 9/99", res.Cost, res.Time)
	}
	// Among cost-10 routes the faster one (via 1, time 2) wins.
	p.Edges[3].Toll = 10
	res = p.Search(0)
	if !res.Found || res.Cost != 10 || res.Time != 2 {
		t.Fatalf("cost=%d time=%d, want 10/2", res.Cost, res.Time)
	}
}
