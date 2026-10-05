package route

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"testing"
)

// build marshals a Network to JSON and reloads it, exercising the same
// validation and indexing the CLI uses.
func build(t *testing.T, n *Network) *Network {
	t.Helper()
	raw, err := json.Marshal(n)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	net, err := Load(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return net
}

func mustLoadErr(t *testing.T, n *Network) {
	t.Helper()
	raw, _ := json.Marshal(n)
	if _, err := Load(bytes.NewReader(raw)); err == nil {
		t.Fatalf("expected validation error, got none")
	}
}

// evalIDs evaluates a path given as a string of node ids, e.g. "ABCD".
func evalIDs(t *testing.T, n *Network, s string) EvalResult {
	t.Helper()
	var path []int
	for _, c := range s {
		v, ok := n.NodeIndex(string(c))
		if !ok {
			t.Fatalf("unknown node %q", string(c))
		}
		path = append(path, v)
	}
	return n.EvalPath(path)
}

func nodeIDs(s string) []Node {
	out := make([]Node, 0, len(s))
	for _, c := range s {
		out = append(out, Node{ID: string(c)})
	}
	return out
}

// --- scenario tests -------------------------------------------------------

// The rebate must not act as a standalone negative edge: it pays out only
// when the cumulative toll qualifies AND a designated station is visited.
func TestRebateOnlyAtDesignatedStation(t *testing.T) {
	mk := func(stations []string) *Network {
		return build(t, &Network{
			Start: "A", End: "D",
			Fuel:   FuelSpec{Capacity: 10, Start: 10},
			Rebate: &Rebate{Threshold: 10, Amount: 7, Stations: stations},
			Nodes:  nodeIDs("ABCD"),
			Edges: []Edge{
				{From: "A", To: "B", Toll: 12, Time: 1, Dist: 1},
				{From: "B", To: "C", Toll: 1, Time: 1, Dist: 1},
				{From: "C", To: "D", Toll: 1, Time: 1, Dist: 1},
			},
		})
	}
	// cumulative toll 12 >= 10 already at B, but no station on the path:
	r := evalIDs(t, mk(nil), "ABCD")
	if !r.OK || r.Rebate != 0 || r.Paid != 14 {
		t.Fatalf("no station: got rebate=%d paid=%d, want rebate=0 paid=14", r.Rebate, r.Paid)
	}
	// C is a designated station: rebate redeemed once on arrival at C.
	r = evalIDs(t, mk([]string{"C"}), "ABCD")
	if !r.OK || r.Rebate != 7 || r.RebateAt != "C" || r.Paid != 7 {
		t.Fatalf("station C: got rebate=%d at=%q paid=%d, want 7/C/7", r.Rebate, r.RebateAt, r.Paid)
	}
	// threshold never reached: no rebate even with a station.
	net := build(t, &Network{
		Start: "A", End: "C",
		Fuel:   FuelSpec{Capacity: 10, Start: 10},
		Rebate: &Rebate{Threshold: 100, Amount: 7, Stations: []string{"C"}},
		Nodes:  nodeIDs("ABC"),
		Edges: []Edge{
			{From: "A", To: "B", Toll: 5, Time: 1, Dist: 1},
			{From: "B", To: "C", Toll: 5, Time: 1, Dist: 1},
		},
	})
	if r := evalIDs(t, net, "ABC"); r.Rebate != 0 || r.Paid != 10 {
		t.Fatalf("threshold unmet: got rebate=%d paid=%d, want 0/10", r.Rebate, r.Paid)
	}
}

// The rebate is single-use even when the path visits two stations after
// qualifying.
func TestRebateRedeemedOnce(t *testing.T) {
	net := build(t, &Network{
		Start: "A", End: "E",
		Fuel:   FuelSpec{Capacity: 10, Start: 10},
		Rebate: &Rebate{Threshold: 5, Amount: 7, Stations: []string{"C", "D"}},
		Nodes:  nodeIDs("ABCDE"),
		Edges: []Edge{
			{From: "A", To: "B", Toll: 6, Time: 1, Dist: 1},
			{From: "B", To: "C", Toll: 1, Time: 1, Dist: 1},
			{From: "C", To: "D", Toll: 1, Time: 1, Dist: 1},
			{From: "D", To: "E", Toll: 1, Time: 1, Dist: 1},
		},
	})
	r := evalIDs(t, net, "ABCDE")
	if r.Rebate != 7 || r.RebateAt != "C" || r.Paid != 2 {
		t.Fatalf("got rebate=%d at=%q paid=%d, want 7/C/2", r.Rebate, r.RebateAt, r.Paid)
	}
}

// Coupons are mutually exclusive: with two eligible coupons only the better
// one applies.
func TestCouponsMutuallyExclusive(t *testing.T) {
	net := build(t, &Network{
		Start: "A", End: "C",
		Fuel:  FuelSpec{Capacity: 10, Start: 10},
		Nodes: nodeIDs("ABC"),
		Edges: []Edge{
			{From: "A", To: "B", Toll: 5, Time: 1, Dist: 1},
			{From: "B", To: "C", Toll: 5, Time: 1, Dist: 1},
		},
		Coupons: []Coupon{
			{ID: "small", Requires: [][2]string{{"A", "B"}}, Discount: 3},
			{ID: "big", Requires: [][2]string{{"A", "B"}, {"B", "C"}}, Discount: 6},
		},
	})
	r := evalIDs(t, net, "ABC")
	if r.CouponID != "big" || r.CouponDisc != 6 || r.Paid != 4 {
		t.Fatalf("got coupon=%q disc=%d paid=%d, want big/6/4", r.CouponID, r.CouponDisc, r.Paid)
	}
}

// A coupon whose required edges were not traveled must not apply.
func TestCouponRequiresTraveledEdges(t *testing.T) {
	net := build(t, &Network{
		Start: "A", End: "D",
		Fuel:  FuelSpec{Capacity: 10, Start: 10},
		Nodes: nodeIDs("ABCD"),
		Edges: []Edge{
			{From: "A", To: "B", Toll: 4, Time: 1, Dist: 1},
			{From: "B", To: "D", Toll: 4, Time: 1, Dist: 1},
			{From: "A", To: "C", Toll: 1, Time: 1, Dist: 1},
			{From: "C", To: "D", Toll: 1, Time: 1, Dist: 1},
		},
		Coupons: []Coupon{
			{ID: "viaB", Requires: [][2]string{{"A", "B"}}, Discount: 5},
		},
	})
	viaB := evalIDs(t, net, "ABD")
	if viaB.CouponID != "viaB" || viaB.Paid != 3 {
		t.Fatalf("via B: got coupon=%q paid=%d, want viaB/3", viaB.CouponID, viaB.Paid)
	}
	viaC := evalIDs(t, net, "ACD")
	if viaC.CouponID != "" || viaC.Paid != 2 {
		t.Fatalf("via C: got coupon=%q paid=%d, want none/2", viaC.CouponID, viaC.Paid)
	}
}

// Fuel capacity constrains routes and refuel cost is part of the paid cost.
func TestFuelCapacityAndRefuelCost(t *testing.T) {
	net := build(t, &Network{
		Start: "A", End: "C",
		Fuel:  FuelSpec{Capacity: 4, Start: 1},
		Nodes: []Node{{ID: "A", FuelPrice: 2}, {ID: "B", FuelPrice: 5}, {ID: "C"}},
		Edges: []Edge{
			{From: "A", To: "B", Toll: 1, Time: 1, Dist: 3},
			{From: "B", To: "C", Toll: 1, Time: 1, Dist: 3},
		},
	})
	r := evalIDs(t, net, "ABC")
	// cheapest plan: buy 3 at A (cost 6) and 2 at B (cost 10): fuel cost 16
	if !r.OK || r.FuelCost != 16 || r.Paid != 18 {
		t.Fatalf("got fuel=%d paid=%d, want 16/18", r.FuelCost, r.Paid)
	}
	if len(r.Steps) != 2 || r.Steps[0].RefuelAt != 3 || r.Steps[1].RefuelAt != 2 {
		t.Fatalf("unexpected refuel plan in ledger: %+v", r.Steps)
	}
	// no fuel sold anywhere and not enough start fuel: infeasible
	dry := build(t, &Network{
		Start: "A", End: "B",
		Fuel:  FuelSpec{Capacity: 4, Start: 1},
		Nodes: nodeIDs("AB"),
		Edges: []Edge{{From: "A", To: "B", Toll: 1, Time: 1, Dist: 3}},
	})
	if r := evalIDs(t, dry, "AB"); r.OK {
		t.Fatalf("expected fuel-infeasible path, got %+v", r)
	}
}

// Paid cost dominates; time breaks ties.
func TestLexicographicObjective(t *testing.T) {
	// cheaper but slower direct edge must win over the faster toll route
	net := build(t, &Network{
		Start: "A", End: "C",
		Fuel:  FuelSpec{Capacity: 10, Start: 10},
		Nodes: nodeIDs("ABC"),
		Edges: []Edge{
			{From: "A", To: "B", Toll: 5, Time: 1, Dist: 1},
			{From: "B", To: "C", Toll: 5, Time: 1, Dist: 1},
			{From: "A", To: "C", Toll: 9, Time: 100, Dist: 1},
		},
	})
	best, ok := net.Enumerate()
	if !ok || best.Paid != 9 || best.Time != 100 {
		t.Fatalf("paid must dominate time: got %+v", best)
	}
	// equal paid: shorter time wins
	net2 := build(t, &Network{
		Start: "A", End: "C",
		Fuel:  FuelSpec{Capacity: 10, Start: 10},
		Nodes: nodeIDs("ABC"),
		Edges: []Edge{
			{From: "A", To: "B", Toll: 5, Time: 1, Dist: 1},
			{From: "B", To: "C", Toll: 5, Time: 1, Dist: 1},
			{From: "A", To: "C", Toll: 10, Time: 1, Dist: 1},
		},
	})
	best2, ok := net2.Enumerate()
	if !ok || best2.Paid != 10 || best2.Time != 1 {
		t.Fatalf("time must break ties: got %+v", best2)
	}
}

// When the expansion budget runs out, the search must still return the best
// feasible route found so far plus a valid lower bound on the optimum.
func TestBudgetKeepsBestAndBound(t *testing.T) {
	net := build(t, &Network{
		Start: "A", End: "F",
		Fuel:   FuelSpec{Capacity: 10, Start: 10},
		Rebate: &Rebate{Threshold: 8, Amount: 4, Stations: []string{"D"}},
		Nodes:  nodeIDs("ABCDEF"),
		Edges: []Edge{
			{From: "A", To: "B", Toll: 3, Time: 2, Dist: 1},
			{From: "A", To: "C", Toll: 4, Time: 1, Dist: 1},
			{From: "B", To: "D", Toll: 6, Time: 2, Dist: 1},
			{From: "C", To: "D", Toll: 5, Time: 3, Dist: 1},
			{From: "C", To: "E", Toll: 2, Time: 1, Dist: 1},
			{From: "D", To: "F", Toll: 3, Time: 2, Dist: 1},
			{From: "E", To: "F", Toll: 4, Time: 1, Dist: 1},
			{From: "B", To: "E", Toll: 1, Time: 5, Dist: 1},
		},
		Coupons: []Coupon{{ID: "k", Requires: [][2]string{{"A", "C"}}, Discount: 2}},
	})
	opt, ok := net.Enumerate()
	if !ok {
		t.Fatal("expected a feasible route")
	}
	full := net.BranchBound(0)
	if !full.Optimal || full.BudgetExceeded || full.Best.Paid != opt.Paid || full.Best.Time != opt.Time {
		t.Fatalf("unlimited B&B must be optimal: got %+v want paid=%d time=%d", full, opt.Paid, opt.Time)
	}
	if full.LowerBound != opt.Paid {
		t.Fatalf("completed search: lower bound %d != optimum %d", full.LowerBound, opt.Paid)
	}
	limited := net.BranchBound(2)
	if !limited.BudgetExceeded || limited.Optimal {
		t.Fatalf("budget=2 must exceed budget: got %+v", limited)
	}
	if limited.LowerBound > opt.Paid {
		t.Fatalf("lower bound %d exceeds optimum %d", limited.LowerBound, opt.Paid)
	}
	if limited.Found && limited.Best.Paid < opt.Paid {
		t.Fatalf("best feasible paid %d below optimum %d: impossible", limited.Best.Paid, opt.Paid)
	}
}

// Network size limits: at most 12 nodes and 6 coupons.
func TestLimits(t *testing.T) {
	mk := func(nNodes, nCoupons int) *Network {
		n := &Network{Start: "n0", End: "n1", Fuel: FuelSpec{Capacity: 1, Start: 1}}
		for i := 0; i < nNodes; i++ {
			n.Nodes = append(n.Nodes, Node{ID: "n" + string(rune('0'+i))})
		}
		// fix ids beyond 9
		for i := range n.Nodes {
			n.Nodes[i].ID = "n" + itoa(i)
		}
		n.Edges = []Edge{{From: "n0", To: "n1", Toll: 1, Time: 1, Dist: 1}}
		for i := 0; i < nCoupons; i++ {
			n.Coupons = append(n.Coupons, Coupon{ID: "c" + itoa(i), Discount: 1})
		}
		return n
	}
	build(t, mk(12, 6))       // exactly at the limits: fine
	mustLoadErr(t, mk(13, 0)) // 13 nodes: too many
	mustLoadErr(t, mk(12, 7)) // 7 coupons: too many
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// The ledger must be internally consistent: per-edge fuel never negative,
// running paid totals add up, and the final paid matches Paid.
func TestLedgerConsistency(t *testing.T) {
	net := build(t, &Network{
		Start: "A", End: "D",
		Fuel:   FuelSpec{Capacity: 5, Start: 2},
		Rebate: &Rebate{Threshold: 6, Amount: 3, Stations: []string{"C"}},
		Nodes:  []Node{{ID: "A", FuelPrice: 2}, {ID: "B", FuelPrice: 1}, {ID: "C"}, {ID: "D"}},
		Edges: []Edge{
			{From: "A", To: "B", Toll: 4, Time: 2, Dist: 3},
			{From: "B", To: "C", Toll: 4, Time: 2, Dist: 3},
			{From: "C", To: "D", Toll: 4, Time: 2, Dist: 2},
		},
		Coupons: []Coupon{{ID: "all", Requires: [][2]string{{"A", "B"}, {"B", "C"}}, Discount: 2}},
	})
	r := evalIDs(t, net, "ABCD")
	if !r.OK {
		t.Fatalf("path should be feasible: %s", r.Reason)
	}
	running := 0
	for i, st := range r.Steps {
		if st.FuelBefore < 0 || st.FuelAfter < 0 || st.FuelAfter > st.FuelBefore {
			t.Fatalf("step %d: bad fuel %d->%d", i, st.FuelBefore, st.FuelAfter)
		}
		running += st.RefuelCost + st.Toll - st.RebateHere
		if st.PaidCum != running {
			t.Fatalf("step %d: PaidCum=%d, running=%d", i, st.PaidCum, running)
		}
	}
	if r.Paid != running-r.CouponDisc {
		t.Fatalf("Paid=%d, running=%d, coupon=%d", r.Paid, running, r.CouponDisc)
	}
	if r.Paid != r.TollSum+r.FuelCost-r.Rebate-r.CouponDisc {
		t.Fatalf("Paid=%d inconsistent with totals %+v", r.Paid, r)
	}
}

// Disconnected end: every solver must report infeasibility.
func TestNoRoute(t *testing.T) {
	net := build(t, &Network{
		Start: "A", End: "C",
		Fuel:  FuelSpec{Capacity: 5, Start: 5},
		Nodes: nodeIDs("ABC"),
		Edges: []Edge{{From: "A", To: "B", Toll: 1, Time: 1, Dist: 1}},
	})
	if _, ok := net.Enumerate(); ok {
		t.Fatal("enumeration: expected no route")
	}
	if _, ok := net.StateSearch(); ok {
		t.Fatal("state search: expected no route")
	}
	if r := net.BranchBound(0); r.Found || !r.Optimal {
		t.Fatalf("branch&bound: expected no route, got %+v", r)
	}
}

// --- randomized cross-check ------------------------------------------------

func randomNetwork(rng *rand.Rand) *Network {
	n := 5 + rng.Intn(2) // 5..6 nodes
	net := &Network{Start: "n0", End: "n" + itoa(n-1)}
	for i := 0; i < n; i++ {
		nd := Node{ID: "n" + itoa(i)}
		if rng.Intn(2) == 0 {
			nd.FuelPrice = 1 + rng.Intn(4)
		}
		net.Nodes = append(net.Nodes, nd)
	}
	cap := 3 + rng.Intn(5)
	net.Fuel = FuelSpec{Capacity: cap, Start: rng.Intn(cap + 1)}
	for i := 0; i < n; i++ {
		for j := 0; j < n; j++ {
			if i != j && rng.Float64() < 0.45 {
				net.Edges = append(net.Edges, Edge{
					From: "n" + itoa(i), To: "n" + itoa(j),
					Toll: 1 + rng.Intn(15), Time: 1 + rng.Intn(10), Dist: rng.Intn(cap + 1),
				})
			}
		}
	}
	if rng.Float64() < 0.7 {
		rb := &Rebate{Threshold: 5 + rng.Intn(21), Amount: 2 + rng.Intn(11)}
		for _, nd := range net.Nodes {
			if rng.Intn(3) == 0 {
				rb.Stations = append(rb.Stations, nd.ID)
			}
		}
		if len(rb.Stations) > 0 {
			net.Rebate = rb
		}
	}
	if len(net.Edges) > 0 {
		for c := 0; c < rng.Intn(4); c++ {
			cp := Coupon{ID: "c" + itoa(c), Discount: 1 + rng.Intn(8)}
			for k := 0; k < 1+rng.Intn(2); k++ {
				e := net.Edges[rng.Intn(len(net.Edges))]
				cp.Requires = append(cp.Requires, [2]string{e.From, e.To})
			}
			net.Coupons = append(net.Coupons, cp)
		}
	}
	return net
}

// Enumeration (ground truth), finite-state search and branch-and-bound must
// agree on every random instance.
func TestCrossCheckRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for iter := 0; iter < 60; iter++ {
		net := build(t, randomNetwork(rng))
		enum, enumOK := net.Enumerate()
		ss, ssOK := net.StateSearch()
		bb := net.BranchBound(0)
		if enumOK != ssOK || enumOK != bb.Found {
			t.Fatalf("iter %d: feasibility disagree enum=%v ss=%v bb=%v", iter, enumOK, ssOK, bb.Found)
		}
		if !enumOK {
			continue
		}
		if ss.Paid != enum.Paid || ss.Time != enum.Time {
			t.Fatalf("iter %d: state search (%d,%d) != enumeration (%d,%d)", iter, ss.Paid, ss.Time, enum.Paid, enum.Time)
		}
		if bb.Best.Paid != enum.Paid || bb.Best.Time != enum.Time || !bb.Optimal {
			t.Fatalf("iter %d: branch&bound (%d,%d) != enumeration (%d,%d)", iter, bb.Best.Paid, bb.Best.Time, enum.Paid, enum.Time)
		}
		if bb.LowerBound != enum.Paid {
			t.Fatalf("iter %d: completed search lower bound %d != optimum %d", iter, bb.LowerBound, enum.Paid)
		}
		// a tight budget must keep a valid bound and a feasible best
		lim := net.BranchBound(1 + rng.Intn(3))
		if lim.BudgetExceeded {
			if lim.LowerBound > enum.Paid {
				t.Fatalf("iter %d: budgeted lower bound %d > optimum %d", iter, lim.LowerBound, enum.Paid)
			}
			if lim.Found && lim.Best.Paid < enum.Paid {
				t.Fatalf("iter %d: budgeted best %d < optimum %d", iter, lim.Best.Paid, enum.Paid)
			}
		} else if lim.Found && (lim.Best.Paid != enum.Paid || lim.Best.Time != enum.Time) {
			t.Fatalf("iter %d: completed budgeted search disagrees: (%d,%d) vs (%d,%d)",
				iter, lim.Best.Paid, lim.Best.Time, enum.Paid, enum.Time)
		}
	}
}
