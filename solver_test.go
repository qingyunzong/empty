package main

import (
	"math/rand"
	"path/filepath"
	"testing"
	"time"
)

// genRandom builds a small random scenario inside the problem limits.
func genRandom(r *rand.Rand) *Scenario {
	n := 3 + r.Intn(3)        // 3..5 nodes
	horizon := 10 + r.Intn(9) // 10..18
	fuelCap := 5 + r.Intn(6)  // 5..10
	sc := &Scenario{
		Nodes:     n,
		Start:     0,
		Goal:      n - 1,
		FuelCap:   fuelCap,
		StartFuel: r.Intn(fuelCap + 1),
		Horizon:   horizon,
	}
	nd := r.Intn(3) // 0..2 coupons
	for i := 0; i < nd; i++ {
		sc.Discounts = append(sc.Discounts, 1+r.Intn(6))
	}
	for u := 0; u < n; u++ {
		for v := 0; v < n; v++ {
			if u == v || r.Intn(100) >= 45 {
				continue
			}
			e := Edge{
				From: u, To: v,
				Fuel: r.Intn(5), Time: 1 + r.Intn(3), Toll: r.Intn(12),
				Discount: -1,
			}
			if nd > 0 && r.Intn(100) < 35 {
				e.Discount = r.Intn(nd)
			}
			if r.Intn(100) < 30 {
				a := r.Intn(horizon / 2)
				e.Windows = []Window{{Start: a, End: a + r.Intn(horizon-a)}}
			}
			sc.Edges = append(sc.Edges, e)
		}
	}
	if r.Intn(100) < 60 {
		st := Station{
			Node: r.Intn(n), Fee: r.Intn(6), Duration: 1 + r.Intn(2),
			Capacity: 1 + r.Intn(2),
		}
		if r.Intn(100) < 50 {
			st.Occupancy = make([]int, horizon+1)
			for t := range st.Occupancy {
				if r.Intn(100) < 25 {
					st.Occupancy[t] = r.Intn(st.Capacity + 1)
				}
			}
		}
		sc.Stations = append(sc.Stations, st)
	}
	return sc
}

// TestCrossCheckRandomTiny compares A* against the independent
// exhaustive search on hundreds of tiny random instances, and replays
// every certificate. This is the "no feasible route pruned away" check.
func TestCrossCheckRandomTiny(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for trial := 0; trial < 400; trial++ {
		sc := genRandom(r)
		if err := sc.Validate(); err != nil {
			t.Fatalf("trial %d: generated invalid scenario: %v", trial, err)
		}
		sv := NewSolver(sc)
		if paused := sv.Run(0, time.Time{}); paused {
			t.Fatalf("trial %d: unexpected pause", trial)
		}
		bfBest, bfFound := BruteForce(sc)
		if sv.Found != bfFound {
			t.Fatalf("trial %d: reachability mismatch: astar=%v brute=%v", trial, sv.Found, bfFound)
		}
		if !sv.Found {
			continue
		}
		if sv.Best != bfBest {
			t.Fatalf("trial %d: cost mismatch: astar=%d brute=%d", trial, sv.Best, bfBest)
		}
		if lb := sv.h[sc.Start]; lb > sv.Best {
			t.Fatalf("trial %d: lower bound %d exceeds optimum %d", trial, lb, sv.Best)
		}
		total, err := sc.Replay(sv.Certificate())
		if err != nil {
			t.Fatalf("trial %d: certificate replay: %v", trial, err)
		}
		if total != sv.Best {
			t.Fatalf("trial %d: certificate total %d != best %d", trial, total, sv.Best)
		}
	}
}

// TestDiscountSingleUse: the same coupon id is carried by three edges,
// including the return leg 1->0 of the same road. The coupon mask must
// allow exactly one discounted traversal, so the optimum pays full toll
// on every further coupon edge instead of re-using the coupon.
func TestDiscountSingleUse(t *testing.T) {
	sc := &Scenario{
		Nodes: 4, Start: 0, Goal: 3,
		FuelCap: 20, StartFuel: 20, Horizon: 30,
		Discounts: []int{6},
		Edges: []Edge{
			{From: 0, To: 1, Fuel: 1, Time: 1, Toll: 10, Discount: 0},
			{From: 1, To: 0, Fuel: 1, Time: 1, Toll: 10, Discount: 0}, // return leg, same coupon
			{From: 1, To: 2, Fuel: 1, Time: 1, Toll: 10, Discount: 0},
			{From: 2, To: 3, Fuel: 1, Time: 1, Toll: 1, Discount: -1},
			{From: 0, To: 3, Fuel: 1, Time: 1, Toll: 100, Discount: -1},
		},
	}
	if err := sc.Validate(); err != nil {
		t.Fatal(err)
	}
	sv := NewSolver(sc)
	sv.Run(0, time.Time{})
	// Optimal: 0->1 with coupon (4) + 1->2 full (10, coupon spent) + 2->3
	// (1) = 15. Illegal reuse on the second coupon edge would give 9.
	if !sv.Found || sv.Best != 15 {
		t.Fatalf("best = %v/%d, want 15", sv.Found, sv.Best)
	}
	uses := 0
	for _, a := range sv.Certificate() {
		if a.Kind == "discount" {
			uses++
		}
	}
	if uses != 1 {
		t.Fatalf("coupon used %d times, want exactly 1", uses)
	}
	if best, found := BruteForce(sc); !found || best != 15 {
		t.Fatalf("brute force = %v/%d, want 15", found, best)
	}
}

// TestTimeWindowWaiting checks the solver waits for a road to open.
func TestTimeWindowWaiting(t *testing.T) {
	sc := &Scenario{
		Nodes: 2, Start: 0, Goal: 1,
		FuelCap: 10, StartFuel: 10, Horizon: 10,
		Edges: []Edge{
			{From: 0, To: 1, Fuel: 1, Time: 2, Toll: 5, Windows: []Window{{Start: 4, End: 6}}, Discount: -1},
			{From: 0, To: 1, Fuel: 1, Time: 1, Toll: 20, Discount: -1},
		},
	}
	sv := NewSolver(sc)
	sv.Run(0, time.Time{})
	if !sv.Found || sv.Best != 5 {
		t.Fatalf("best = %v/%d, want 5 (wait for the cheap road)", sv.Found, sv.Best)
	}
	var drive *Action
	cert := sv.Certificate()
	for i, a := range cert {
		if a.Kind == "drive" && a.Edge == 0 {
			drive = &cert[i]
		}
	}
	if drive == nil || drive.Depart != 4 || drive.Arrive != 6 {
		t.Fatalf("windowed drive = %+v, want depart 4 arrive 6", drive)
	}
}

// TestChargingCapacity checks a fully booked slot forces a later refuel.
func TestChargingCapacity(t *testing.T) {
	occ := make([]int, MaxHorizon+1)
	for t := 0; t <= 2; t++ {
		occ[t] = 1
	}
	sc := &Scenario{
		Nodes: 2, Start: 0, Goal: 1,
		FuelCap: 4, StartFuel: 0, Horizon: 10,
		Edges:    []Edge{{From: 0, To: 1, Fuel: 2, Time: 1, Toll: 7, Discount: -1}},
		Stations: []Station{{Node: 0, Fee: 0, Duration: 1, Capacity: 1, Occupancy: occ}},
	}
	sv := NewSolver(sc)
	sv.Run(0, time.Time{})
	if !sv.Found || sv.Best != 7 {
		t.Fatalf("best = %v/%d, want 7", sv.Found, sv.Best)
	}
	var refuel *Action
	cert := sv.Certificate()
	for i, a := range cert {
		if a.Kind == "refuel" {
			refuel = &cert[i]
		}
	}
	if refuel == nil || refuel.Depart != 3 {
		t.Fatalf("refuel = %+v, want depart t=3 (slots 0..2 full)", refuel)
	}
}

// TestChargingCapacityFull makes the goal unreachable by booking every
// slot; both searches must agree.
func TestChargingCapacityFull(t *testing.T) {
	occ := make([]int, MaxHorizon+1)
	for t := range occ {
		occ[t] = 1
	}
	sc := &Scenario{
		Nodes: 2, Start: 0, Goal: 1,
		FuelCap: 4, StartFuel: 0, Horizon: 10,
		Edges:    []Edge{{From: 0, To: 1, Fuel: 2, Time: 1, Toll: 7, Discount: -1}},
		Stations: []Station{{Node: 0, Fee: 0, Duration: 1, Capacity: 1, Occupancy: occ}},
	}
	sv := NewSolver(sc)
	sv.Run(0, time.Time{})
	if sv.Found {
		t.Fatalf("expected unreachable, got cost %d", sv.Best)
	}
	if _, found := BruteForce(sc); found {
		t.Fatal("brute force disagrees: found a route")
	}
}

// TestPauseResume verifies a paused-and-resumed search (through a JSON
// snapshot on disk) reaches exactly the same result as one full run.
func TestPauseResume(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	path := filepath.Join(t.TempDir(), "frontier.json")
	for trial := 0; trial < 60; trial++ {
		sc := genRandom(r)
		full := NewSolver(sc)
		full.Run(0, time.Time{})

		part := NewSolver(sc)
		for i := 0; ; i++ {
			if i > 5000 {
				t.Fatalf("trial %d: resume loop not converging", trial)
			}
			if paused := part.Run(2+r.Intn(4), time.Time{}); !paused {
				break
			}
			if err := part.SaveSnapshot(path); err != nil {
				t.Fatal(err)
			}
			var err error
			part, err = ResumeSolver(sc, path)
			if err != nil {
				t.Fatal(err)
			}
		}
		if part.Found != full.Found || part.Best != full.Best {
			t.Fatalf("trial %d: pause/resume = (%v,%d), full run = (%v,%d)",
				trial, part.Found, part.Best, full.Found, full.Best)
		}
	}
}

// TestFrontierLowerBoundMonotone checks the paused frontier lower bound
// never exceeds the final optimum.
func TestFrontierLowerBoundMonotone(t *testing.T) {
	r := rand.New(rand.NewSource(11))
	for trial := 0; trial < 60; trial++ {
		sc := genRandom(r)
		sv := NewSolver(sc)
		var lbs []int
		for {
			if !sv.Run(3, time.Time{}) {
				break
			}
			lbs = append(lbs, sv.FrontierLowerBound())
			if len(lbs) > 20000 {
				t.Fatalf("trial %d: not converging", trial)
			}
		}
		if !sv.Found {
			continue
		}
		for i, lb := range lbs {
			if lb > sv.Best {
				t.Fatalf("trial %d: paused frontier lb %d (pause %d) > best %d", trial, lb, i, sv.Best)
			}
		}
		if sv.FrontierLowerBound() != sv.Best {
			t.Fatalf("trial %d: final lb %d != best %d", trial, sv.FrontierLowerBound(), sv.Best)
		}
	}
}

func TestValidation(t *testing.T) {
	base := func() *Scenario {
		return &Scenario{
			Nodes: 2, Start: 0, Goal: 1,
			FuelCap: 10, StartFuel: 5, Horizon: 10,
			Edges: []Edge{{From: 0, To: 1, Fuel: 1, Time: 1, Toll: 1, Discount: -1}},
		}
	}
	cases := []struct {
		name   string
		mutate func(*Scenario)
	}{
		{"too many nodes", func(sc *Scenario) { sc.Nodes = MaxNodes + 1 }},
		{"horizon too large", func(sc *Scenario) { sc.Horizon = MaxHorizon + 1 }},
		{"fuel cap too large", func(sc *Scenario) { sc.FuelCap = MaxFuelCap + 1; sc.StartFuel = 5 }},
		{"too many discounts", func(sc *Scenario) { sc.Discounts = make([]int, MaxDiscounts+1) }},
		{"negative toll", func(sc *Scenario) { sc.Edges[0].Toll = -1 }},
		{"zero travel time", func(sc *Scenario) { sc.Edges[0].Time = 0 }},
		{"negative fuel", func(sc *Scenario) { sc.Edges[0].Fuel = -1 }},
		{"bad discount id", func(sc *Scenario) { sc.Edges[0].Discount = 0 }},
		{"bad window", func(sc *Scenario) { sc.Edges[0].Windows = []Window{{Start: 8, End: 2}} }},
	}
	for _, tc := range cases {
		sc := base()
		tc.mutate(sc)
		if err := sc.Validate(); err == nil {
			t.Errorf("%s: expected validation error", tc.name)
		}
	}
	if err := base().Validate(); err != nil {
		t.Errorf("base scenario should validate: %v", err)
	}
}

func TestUnreachable(t *testing.T) {
	sc := &Scenario{
		Nodes: 3, Start: 0, Goal: 2,
		FuelCap: 5, StartFuel: 5, Horizon: 10,
		Edges: []Edge{{From: 0, To: 1, Fuel: 1, Time: 1, Toll: 1, Discount: -1}},
	}
	sv := NewSolver(sc)
	sv.Run(0, time.Time{})
	if sv.Found {
		t.Fatal("goal should be unreachable")
	}
	if _, found := BruteForce(sc); found {
		t.Fatal("brute force disagrees")
	}
}

// TestDemoScenario keeps the shipped example consistent between the two
// search engines and its own certificate.
func TestDemoScenario(t *testing.T) {
	sc := demoScenario()
	if err := sc.Validate(); err != nil {
		t.Fatal(err)
	}
	sv := NewSolver(sc)
	sv.Run(0, time.Time{})
	if !sv.Found {
		t.Fatal("demo scenario should be solvable")
	}
	if best, found := BruteForce(sc); !found || best != sv.Best {
		t.Fatalf("demo mismatch: astar=%d brute=%v/%d", sv.Best, found, best)
	}
	total, err := sc.Replay(sv.Certificate())
	if err != nil || total != sv.Best {
		t.Fatalf("demo certificate: total=%d best=%d err=%v", total, sv.Best, err)
	}
}

// TestScenarioFile makes sure the checked-in example stays valid and
// matches the built-in demo.
func TestScenarioFile(t *testing.T) {
	sc, err := LoadScenario("scenario.json")
	if err != nil {
		t.Fatal(err)
	}
	sv := NewSolver(sc)
	sv.Run(0, time.Time{})
	demo := NewSolver(demoScenario())
	demo.Run(0, time.Time{})
	if sv.Found != demo.Found || sv.Best != demo.Best {
		t.Fatalf("scenario.json = (%v,%d), demo = (%v,%d)", sv.Found, sv.Best, demo.Found, demo.Best)
	}
}
