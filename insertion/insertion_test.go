package insertion

import (
	"math"
	"math/rand"
	"reflect"
	"testing"
)

const eps = 1e-9

func wideWindow(s Stop) Stop {
	s.Ready, s.Due = 0, 1e9
	return s
}

func baseProblem() *Problem {
	return &Problem{
		Depot:    Stop{ID: "depot", X: 0, Y: 0},
		Capacity: 10,
		Pickup:   wideWindow(Stop{ID: "P", X: 1, Y: 1, Demand: 2}),
		Delivery: wideWindow(Stop{ID: "D", X: 2, Y: 1, Demand: -2}),
	}
}

// Old order must be preserved: the optimal insertion keeps the relative
// order of all old stops.
func TestOldOrderPreserved(t *testing.T) {
	p := baseProblem()
	p.Stops = []Stop{
		wideWindow(Stop{ID: "A", X: 10, Y: 0}),
		wideWindow(Stop{ID: "B", X: 20, Y: 0}),
		wideWindow(Stop{ID: "C", X: 30, Y: 0}),
	}
	res, err := p.BestInsertion()
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible {
		t.Fatalf("expected feasible, got violations %v", res.ViolatedRules)
	}
	route := p.buildRoute(res.PickupPos, res.DeliveryPos)
	order := []string{}
	for _, s := range route {
		order = append(order, s.ID)
	}
	ai, bi, ci := indexOf(order, "A"), indexOf(order, "B"), indexOf(order, "C")
	if !(ai < bi && bi < ci) {
		t.Fatalf("old order changed: %v", order)
	}
	pi, di := indexOf(order, "P"), indexOf(order, "D")
	if pi >= di {
		t.Fatalf("pickup not before delivery: %v", order)
	}
}

func indexOf(s []string, id string) int {
	for i, v := range s {
		if v == id {
			return i
		}
	}
	return -1
}

// A cheap detour that visits the delivery before the pickup must be rejected;
// the chosen insertion has the pickup first even at a higher cost.
func TestPrecedenceEnforced(t *testing.T) {
	p := baseProblem()
	p.Stops = nil
	p.Pickup = wideWindow(Stop{ID: "P", X: 100, Y: 0, Demand: 2})
	p.Delivery = wideWindow(Stop{ID: "D", X: 1, Y: 0, Demand: -2})
	res, err := p.BestInsertion()
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible {
		t.Fatalf("expected feasible, got %v", res.ViolatedRules)
	}
	// depot(0) -> D(1) -> P(100) -> depot would be ~200 but is forbidden;
	// the only legal order is depot -> P -> D -> depot: 100 + 99 + 1 = 200.
	want := 200.0
	if math.Abs(res.ExtraDistance-want) > eps {
		t.Fatalf("extra distance = %v, want %v", res.ExtraDistance, want)
	}
}

// Capacity: the new order's load only fits if the pickup happens after an old
// delivery frees space; the search must find exactly that gap.
func TestCapacityGapSelection(t *testing.T) {
	p := baseProblem()
	p.Capacity = 5
	p.Pickup = wideWindow(Stop{ID: "P", X: 5, Y: 1, Demand: 4})
	p.Delivery = wideWindow(Stop{ID: "D", X: 6, Y: 1, Demand: -4})
	p.Stops = []Stop{
		wideWindow(Stop{ID: "load", X: 5, Y: 0, Demand: 3}),
		wideWindow(Stop{ID: "unload", X: 10, Y: 0, Demand: -3}),
	}
	res, err := p.BestInsertion()
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible {
		t.Fatalf("expected feasible, got %v", res.ViolatedRules)
	}
	// Pickup (4) only fits after "unload" freed 3 units: load goes
	// 3 -> 0 -> 4 -> 0. So the pickup gap must be 2 (after both old stops).
	if res.PickupPos != 2 {
		t.Fatalf("pickup gap = %d, want 2", res.PickupPos)
	}
}

// Infeasible by capacity alone: the violated-rule set must report capacity.
func TestInfeasibleCapacity(t *testing.T) {
	p := baseProblem()
	p.Capacity = 3
	p.Pickup = wideWindow(Stop{ID: "P", X: 1, Y: 1, Demand: 4})
	p.Delivery = wideWindow(Stop{ID: "D", X: 2, Y: 1, Demand: -4})
	res, err := p.BestInsertion()
	if err != nil {
		t.Fatal(err)
	}
	if res.Feasible {
		t.Fatal("expected infeasible")
	}
	want := []string{RuleCapacity}
	if !reflect.DeepEqual(res.ViolatedRules, want) {
		t.Fatalf("violated rules = %v, want %v", res.ViolatedRules, want)
	}
}

// Infeasible by time window alone: the delivery window closes before the
// vehicle can possibly arrive.
func TestInfeasibleTimeWindow(t *testing.T) {
	p := baseProblem()
	p.Pickup = wideWindow(Stop{ID: "P", X: 50, Y: 0, Demand: 2})
	p.Delivery = Stop{ID: "D", X: 60, Y: 0, Demand: -2, Ready: 0, Due: 10}
	res, err := p.BestInsertion()
	if err != nil {
		t.Fatal(err)
	}
	if res.Feasible {
		t.Fatal("expected infeasible")
	}
	want := []string{RuleTimeWindow}
	if !reflect.DeepEqual(res.ViolatedRules, want) {
		t.Fatalf("violated rules = %v, want %v", res.ViolatedRules, want)
	}
}

// Both rules blocked: every insertion violates capacity and some time window.
func TestInfeasibleMultipleRules(t *testing.T) {
	p := baseProblem()
	p.Capacity = 1
	p.Pickup = wideWindow(Stop{ID: "P", X: 1, Y: 1, Demand: 2})
	p.Delivery = Stop{ID: "D", X: 2, Y: 1, Demand: -2, Ready: 0, Due: 0.5}
	res, err := p.BestInsertion()
	if err != nil {
		t.Fatal(err)
	}
	if res.Feasible {
		t.Fatal("expected infeasible")
	}
	want := []string{RuleCapacity, RuleTimeWindow}
	if !reflect.DeepEqual(res.ViolatedRules, want) {
		t.Fatalf("violated rules = %v, want %v", res.ViolatedRules, want)
	}
}

// Waiting for a window to open is allowed and must not count as a violation.
func TestWaitingAllowed(t *testing.T) {
	p := baseProblem()
	p.Pickup = Stop{ID: "P", X: 1, Y: 0, Demand: 2, Ready: 100, Due: 1e9}
	p.Delivery = wideWindow(Stop{ID: "D", X: 2, Y: 0, Demand: -2})
	res, err := p.BestInsertion()
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible {
		t.Fatalf("expected feasible with waiting, got %v", res.ViolatedRules)
	}
}

func TestTooManyOldStops(t *testing.T) {
	p := baseProblem()
	p.Stops = make([]Stop, MaxOldStops+1)
	if _, err := p.BestInsertion(); err == nil {
		t.Fatal("expected error for more than MaxOldStops old stops")
	}
}

func TestEmptyOldRoute(t *testing.T) {
	p := baseProblem()
	res, err := p.BestInsertion()
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible {
		t.Fatalf("expected feasible, got %v", res.ViolatedRules)
	}
	if res.PickupPos != 0 || res.DeliveryPos != 0 {
		t.Fatalf("positions = (%d,%d), want (0,0)", res.PickupPos, res.DeliveryPos)
	}
}

// Cross-check: BestInsertion (incremental local-delta cost) must agree with
// BruteForceAll (full rebuild, full distance recompute) on random instances,
// including the violated-rule sets when infeasible.
func TestCrossCheckAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 2000; iter++ {
		n := rng.Intn(MaxOldStops + 1)
		p := &Problem{
			Depot:       Stop{ID: "depot"},
			Capacity:    1 + rng.Intn(12),
			InitialLoad: rng.Intn(3),
			StartTime:   0,
		}
		load := p.InitialLoad
		for k := 0; k < n; k++ {
			s := randomStop(rng, "S"+itoa(k))
			// keep old route loads non-negative so instances stay meaningful
			if s.Demand < 0 && load+s.Demand < 0 {
				s.Demand = -load
			}
			load += s.Demand
			if load > p.Capacity {
				s.Demand -= load - p.Capacity
				load = p.Capacity
			}
			p.Stops = append(p.Stops, s)
		}
		q := 1 + rng.Intn(6)
		p.Pickup = randomStop(rng, "P")
		p.Pickup.Demand = q
		p.Delivery = randomStop(rng, "D")
		p.Delivery.Demand = -q

		fast, err := p.BestInsertion()
		if err != nil {
			t.Fatal(err)
		}
		slow, err := p.BruteForceAll()
		if err != nil {
			t.Fatal(err)
		}
		if fast.Feasible != slow.Feasible {
			t.Fatalf("iter %d: feasibility mismatch fast=%v slow=%v\n%+v", iter, fast.Feasible, slow.Feasible, p)
		}
		if !fast.Feasible {
			if !reflect.DeepEqual(fast.ViolatedRules, slow.ViolatedRules) {
				t.Fatalf("iter %d: violated rules fast=%v slow=%v", iter, fast.ViolatedRules, slow.ViolatedRules)
			}
			continue
		}
		if math.Abs(fast.ExtraDistance-slow.ExtraDistance) > 1e-6 {
			t.Fatalf("iter %d: extra distance fast=%v slow=%v", iter, fast.ExtraDistance, slow.ExtraDistance)
		}
		// the reported insertion must itself be feasible and optimal
		route := p.buildRoute(fast.PickupPos, fast.DeliveryPos)
		if v := p.checkRoute(route); len(v) > 0 {
			t.Fatalf("iter %d: chosen insertion violates %v", iter, v)
		}
		got := routeDistance(route) - routeDistance(p.routeNodes())
		if math.Abs(got-fast.ExtraDistance) > 1e-6 {
			t.Fatalf("iter %d: local delta %v != rebuilt delta %v", iter, fast.ExtraDistance, got)
		}
	}
}

func randomStop(rng *rand.Rand, id string) Stop {
	s := Stop{
		ID:      id,
		X:       rng.Float64() * 100,
		Y:       rng.Float64() * 100,
		Demand:  rng.Intn(7) - 3,
		Service: rng.Float64() * 5,
	}
	// mostly wide windows, sometimes tight ones
	if rng.Intn(3) == 0 {
		s.Ready = rng.Float64() * 50
		s.Due = s.Ready + rng.Float64()*200
	} else {
		s.Ready, s.Due = 0, 1e9
	}
	return s
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	buf := [8]byte{}
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}
