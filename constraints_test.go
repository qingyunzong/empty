package main

import "testing"

func solveCost(g *Graph) (int, bool) {
	s := NewSolver(g, false)
	s.Run(0)
	return s.Best, s.Found
}

// TestCouponSingleUseOnReturn: both edges accept coupon 0, but the coupon is
// one-time, so only one traversal can be discounted even though the route
// would love to spend it twice.
func TestCouponSingleUseOnReturn(t *testing.T) {
	g := &Graph{
		NumNodes: 3, Start: 0, Goal: 2, MaxFuel: 20, MaxTime: 60,
		Edges: []Edge{
			{From: 0, To: 1, Fuel: 1, Time: 1, Toll: 10, Coupon: 0, Discount: 10},
			{From: 1, To: 2, Fuel: 1, Time: 1, Toll: 10, Coupon: 0, Discount: 10},
		},
	}
	cost, found := solveCost(g)
	if !found {
		t.Fatal("expected a feasible route")
	}
	// One traversal discounted to 0, the other pays full toll.
	// Edge 0: fuel 20 -> toll 10+0=10, with coupon 0.
	// Edge 1: fuel 19 -> toll 10+(20-19)/2=10, with coupon 0.
	// Single-use optimum = 0 + 10 = 10; a reusable coupon would give 0.
	if cost != 10 {
		t.Fatalf("cost %d, want 10 (coupon must be single-use)", cost)
	}
	s := NewSolver(g, false)
	s.Run(0)
	cert := BuildCertificate(s)
	uses := 0
	for _, st := range cert.Steps {
		if st.UseCoupon {
			uses++
		}
	}
	if uses != 1 {
		t.Fatalf("certificate spends the coupon %d times, want exactly 1", uses)
	}
	if err := VerifyCertificate(g, cert); err != nil {
		t.Fatal(err)
	}
}

// TestWindowClosedEdge: the direct edge's window is too short to ever fit the
// traversal, so the solver must take the detour.
func TestWindowClosedEdge(t *testing.T) {
	g := &Graph{
		NumNodes: 3, Start: 0, Goal: 2, MaxFuel: 20, MaxTime: 60,
		Edges: []Edge{
			{From: 0, To: 2, Fuel: 1, Time: 5, Toll: 1, Windows: []Window{{Start: 10, End: 12}}},
			{From: 0, To: 1, Fuel: 1, Time: 1, Toll: 3},
			{From: 1, To: 2, Fuel: 1, Time: 1, Toll: 3},
		},
	}
	cost, found := solveCost(g)
	if !found {
		t.Fatal("expected the detour to be feasible")
	}
	// Detour: 3 + 3+0 (surcharge (20-19)/2=0) = 6; direct edge unusable.
	if cost != 6 {
		t.Fatalf("cost %d, want 6 (closed direct edge must not be used)", cost)
	}
}

// TestWindowWaiting: the vehicle must wait at node 1 until the window opens.
func TestWindowWaiting(t *testing.T) {
	g := &Graph{
		NumNodes: 3, Start: 0, Goal: 2, MaxFuel: 20, MaxTime: 60,
		Edges: []Edge{
			{From: 0, To: 1, Fuel: 1, Time: 1, Toll: 0},
			{From: 1, To: 2, Fuel: 1, Time: 2, Toll: 0, Windows: []Window{{Start: 8, End: 20}}},
		},
	}
	s := NewSolver(g, false)
	s.Run(0)
	if !s.Found {
		t.Fatal("expected a feasible route with waiting")
	}
	cert := BuildCertificate(s)
	last := cert.Steps[len(cert.Steps)-1]
	if last.To.Time != 10 { // depart at 8 (wait 7), arrive at 10
		t.Fatalf("arrival time %d, want 10 (wait for window)", last.To.Time)
	}
}

// TestStationChargingSlots: the linear route needs one refuel at each of
// two stations, so it is feasible only when both stations have a free
// charging slot.
func TestStationChargingSlots(t *testing.T) {
	edges := []Edge{
		{From: 0, To: 1, Fuel: 9, Time: 1, Toll: 0},
		{From: 1, To: 2, Fuel: 9, Time: 1, Toll: 0},
		{From: 2, To: 3, Fuel: 9, Time: 1, Toll: 0},
	}
	// Fuel trace with caps (1,1): 10 -9-> 1, refuel +9 -> 10 (slot 1 used),
	// -9-> 1, refuel +8 -> 9 (slot 2 used), -9-> 0 at goal. Cost 9+8=17.
	for _, tc := range []struct {
		cap1, cap2 int
		feasible   bool
	}{{1, 1, true}, {1, 0, false}, {0, 1, false}, {0, 0, false}} {
		g := &Graph{
			NumNodes: 4, Start: 0, Goal: 3, MaxFuel: 10, MaxTime: 60,
			Edges: edges,
			Stations: []Station{
				{Node: 1, Price: 1, RefuelTime: 1, Capacity: tc.cap1},
				{Node: 2, Price: 1, RefuelTime: 1, Capacity: tc.cap2},
			},
		}
		cost, found := solveCost(g)
		if found != tc.feasible {
			t.Fatalf("caps (%d,%d): feasible=%v, want %v", tc.cap1, tc.cap2, found, tc.feasible)
		}
		if tc.feasible && cost != 17 {
			t.Fatalf("caps (%d,%d): cost %d, want 17", tc.cap1, tc.cap2, cost)
		}
		if _, exFound := Exhaustive(g); exFound != tc.feasible {
			t.Fatalf("caps (%d,%d): exhaustive feasible=%v", tc.cap1, tc.cap2, exFound)
		}
	}
	// The feasible certificate must contain exactly two refuel actions and
	// drain both stations' slots.
	g := &Graph{
		NumNodes: 4, Start: 0, Goal: 3, MaxFuel: 10, MaxTime: 60,
		Edges:    edges,
		Stations: []Station{
			{Node: 1, Price: 1, RefuelTime: 1, Capacity: 1},
			{Node: 2, Price: 1, RefuelTime: 1, Capacity: 1},
		},
	}
	s := NewSolver(g, false)
	s.Run(0)
	cert := BuildCertificate(s)
	refuels := 0
	for _, st := range cert.Steps {
		if st.Action == "refuel" {
			refuels++
			if st.To.Slots[st.Station] != 0 {
				t.Fatalf("station %d slot not consumed: %v", st.Station, st.To.Slots)
			}
		}
	}
	if refuels != 2 {
		t.Fatalf("certificate has %d refuels, want 2", refuels)
	}
	if err := VerifyCertificate(g, cert); err != nil {
		t.Fatal(err)
	}
}

// TestRefuelSlotConsumed: a station with no free slots offers no refuel
// transitions.
func TestRefuelSlotConsumed(t *testing.T) {
	g := &Graph{
		NumNodes: 2, Start: 0, Goal: 1, MaxFuel: 10, MaxTime: 60,
		Stations: []Station{{Node: 0, Price: 1, RefuelTime: 1, Capacity: 1}},
	}
	full := g.InitialState()
	full.Fuel = 5 // room for 1..5 units
	if n := countRefuel(g, full); n != 5 {
		t.Fatalf("full slot: %d refuel successors, want 5", n)
	}
	empty := full
	empty.Slots[0] = 0
	if n := countRefuel(g, empty); n != 0 {
		t.Fatalf("empty slot: %d refuel successors, want 0", n)
	}
}

func countRefuel(g *Graph, s State) int {
	n := 0
	for _, succ := range g.Successors(s) {
		if succ.Tr.Kind == "refuel" {
			n++
		}
	}
	return n
}

// TestTimeHorizon: total travel time must stay within the horizon of 60.
func TestTimeHorizon(t *testing.T) {
	g := &Graph{
		NumNodes: 3, Start: 0, Goal: 2, MaxFuel: 20, MaxTime: 60,
		Edges: []Edge{
			{From: 0, To: 1, Fuel: 1, Time: 40, Toll: 0},
			{From: 1, To: 2, Fuel: 1, Time: 40, Toll: 0},
		},
	}
	if _, found := solveCost(g); found {
		t.Fatal("route of total time 80 must be infeasible within time 60")
	}
	g.Edges[1].Time = 20
	if _, found := solveCost(g); !found {
		t.Fatal("route of total time 60 must be feasible")
	}
}

// TestNonNegativeCosts: a discount larger than the toll floors at 0, never
// negative, and all produced transition costs are non-negative.
func TestNonNegativeCosts(t *testing.T) {
	g := &Graph{
		NumNodes: 2, Start: 0, Goal: 1, MaxFuel: 20, MaxTime: 60,
		Edges: []Edge{
			{From: 0, To: 1, Fuel: 1, Time: 1, Toll: 0, Coupon: 0, Discount: 10},
		},
	}
	cost, found := solveCost(g)
	if !found || cost != 0 {
		t.Fatalf("cost %d found %v, want 0/true (discount floors at 0)", cost, found)
	}
	e := g.Edges[0]
	if got := g.TollPaid(e, 20, true); got != 0 {
		t.Fatalf("TollPaid with big discount = %d, want 0", got)
	}
	if got := g.TollPaid(e, 10, false); got != 5 {
		t.Fatalf("TollPaid low-fuel surcharge = %d, want 5", got)
	}
	if got := g.TollPaid(e, 20, false); got != 0 {
		t.Fatalf("TollPaid full tank = %d, want 0", got)
	}
}

// TestTollDependsOnRemainingFuel: the same edge costs more with less fuel.
func TestTollDependsOnRemainingFuel(t *testing.T) {
	g := &Graph{MaxFuel: 20}
	e := Edge{Toll: 4, Coupon: -1}
	prev := -1
	for fuel := 20; fuel >= 0; fuel -= 2 {
		got := g.TollPaid(e, fuel, false)
		if got < 0 {
			t.Fatalf("negative toll %d", got)
		}
		if prev >= 0 && got < prev {
			t.Fatalf("toll not monotone in remaining fuel: fuel %d -> %d < %d", fuel, got, prev)
		}
		prev = got
	}
}
