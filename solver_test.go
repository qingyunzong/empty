package routeinsert

import (
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"testing"
)

func looseStop(id string, x, y float64) Stop {
	return Stop{ID: id, Pos: Point{x, y}, Ready: 0, Due: 1000}
}

func TestSolveBasicFeasible(t *testing.T) {
	p := Problem{
		Vehicle: Vehicle{Capacity: 5, Start: Point{0, 0}, Depart: 0, Speed: 1},
		Old: []Stop{
			looseStop("A", 10, 0),
			looseStop("B", 30, 0),
		},
		New: []Stop{
			{ID: "P", Pos: Point{10, 10}, Load: 2, Ready: 0, Due: 1000, Order: "o1", Kind: Pickup},
			{ID: "D", Pos: Point{30, 10}, Load: -2, Ready: 0, Due: 1000, Order: "o1", Kind: Delivery},
		},
	}
	res := Solve(p)
	if !res.Feasible {
		t.Fatalf("expected feasible, got violations %v", res.Violations)
	}
	if math.Abs(res.ExtraDistance-20) > 1e-9 {
		t.Fatalf("extra distance = %v, want 20", res.ExtraDistance)
	}
	var ids []string
	for _, s := range res.Seq {
		ids = append(ids, s.ID)
	}
	want := []string{"A", "P", "D", "B"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("sequence = %v, want %v", ids, want)
	}
}

func TestSolveNoNewStops(t *testing.T) {
	p := Problem{
		Vehicle: Vehicle{Capacity: 5, Start: Point{0, 0}, Speed: 1},
		Old:     []Stop{looseStop("A", 3, 4)},
	}
	res := Solve(p)
	if !res.Feasible || res.ExtraDistance != 0 || len(res.Seq) != 1 {
		t.Fatalf("got %+v", res)
	}
}

func TestInfeasibleCapacity(t *testing.T) {
	p := Problem{
		Vehicle: Vehicle{Capacity: 1, Start: Point{0, 0}, Speed: 1},
		Old:     []Stop{looseStop("A", 10, 0)},
		New: []Stop{
			{ID: "P", Pos: Point{5, 0}, Load: 2, Ready: 0, Due: 1000, Order: "o1", Kind: Pickup},
			{ID: "D", Pos: Point{8, 0}, Load: -2, Ready: 0, Due: 1000, Order: "o1", Kind: Delivery},
		},
	}
	res := Solve(p)
	if res.Feasible {
		t.Fatalf("expected infeasible, got %+v", res)
	}
	if !reflect.DeepEqual(res.Violations, []Rule{RuleCapacity}) {
		t.Fatalf("violations = %v, want [capacity]", res.Violations)
	}
}

func TestInfeasibleTimeWindow(t *testing.T) {
	p := Problem{
		Vehicle: Vehicle{Capacity: 10, Start: Point{0, 0}, Speed: 1},
		Old:     []Stop{looseStop("A", 1, 0)},
		New: []Stop{
			{ID: "P", Pos: Point{100, 0}, Load: 1, Ready: 0, Due: 5, Order: "o1", Kind: Pickup},
			{ID: "D", Pos: Point{101, 0}, Load: -1, Ready: 0, Due: 1000, Order: "o1", Kind: Delivery},
		},
	}
	res := Solve(p)
	if res.Feasible {
		t.Fatalf("expected infeasible, got %+v", res)
	}
	if !reflect.DeepEqual(res.Violations, []Rule{RuleTimeWindow}) {
		t.Fatalf("violations = %v, want [time_window]", res.Violations)
	}
}

func TestInfeasiblePrecedenceFromOldOrder(t *testing.T) {
	// The fixed old sequence serves the delivery before its pickup; no
	// insertion can repair that.
	p := Problem{
		Vehicle: Vehicle{Capacity: 10, Start: Point{0, 0}, Speed: 1},
		Old: []Stop{
			{ID: "D", Pos: Point{1, 0}, Load: -1, Ready: 0, Due: 1000, Order: "x", Kind: Delivery},
			{ID: "P", Pos: Point{2, 0}, Load: 1, Ready: 0, Due: 1000, Order: "x", Kind: Pickup},
		},
		New: []Stop{looseStop("N", 5, 0)},
	}
	res := Solve(p)
	if res.Feasible {
		t.Fatalf("expected infeasible, got %+v", res)
	}
	found := false
	for _, r := range res.Violations {
		if r == RulePrecedence {
			found = true
		}
	}
	if !found {
		t.Fatalf("violations = %v, want precedence included", res.Violations)
	}
}

// crossCheck compares Solve against the exhaustive enumeration ground truth.
func crossCheck(t *testing.T, p Problem) {
	t.Helper()
	res := Solve(p)
	cands := EnumerateAll(p)
	base := RouteDistance(p.Vehicle, p.Old)

	best := math.Inf(1)
	for _, c := range cands {
		if c.Feasible() && c.Distance-base < best {
			best = c.Distance - base
		}
	}
	enumFeasible := !math.IsInf(best, 1)
	if res.Feasible != enumFeasible {
		t.Fatalf("feasibility mismatch: solve=%v enumerate=%v", res.Feasible, enumFeasible)
	}
	if res.Feasible {
		if math.Abs(res.ExtraDistance-best) > 1e-9 {
			t.Fatalf("extra distance: solve=%v enumerate=%v", res.ExtraDistance, best)
		}
		// The returned sequence must itself be feasible, preserve the old
		// order and attain the reported extra distance.
		d, v := Simulate(p.Vehicle, res.Seq)
		if len(v) != 0 {
			t.Fatalf("solver sequence violates %v", v)
		}
		if math.Abs(d-base-res.ExtraDistance) > 1e-9 {
			t.Fatalf("sequence distance %v inconsistent with extra %v", d-base, res.ExtraDistance)
		}
		var oldIDs, wantOld []string
		inOld := map[string]bool{}
		for _, s := range p.Old {
			inOld[s.ID] = true
			wantOld = append(wantOld, s.ID)
		}
		for _, s := range res.Seq {
			if inOld[s.ID] {
				oldIDs = append(oldIDs, s.ID)
			}
		}
		if !reflect.DeepEqual(oldIDs, wantOld) {
			t.Fatalf("old order not preserved: %v vs %v", oldIDs, wantOld)
		}
		return
	}
	// Infeasible: a rule is reported iff every candidate violates it.
	var want []Rule
	for _, r := range AllRules {
		all := true
		for _, c := range cands {
			if !c.Violated[r] {
				all = false
				break
			}
		}
		if all {
			want = append(want, r)
		}
	}
	if !reflect.DeepEqual(res.Violations, want) {
		t.Fatalf("violations: solve=%v enumerate=%v", res.Violations, want)
	}
}

func TestCrossCheckRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 300; iter++ {
		nOld := rng.Intn(7)        // 0..6 old stops
		nOrders := 1 + rng.Intn(2) // 1..2 new orders
		p := Problem{
			Vehicle: Vehicle{
				Capacity: 2 + rng.Float64()*6,
				Start:    Point{rng.Float64() * 50, rng.Float64() * 50},
				Speed:    1,
			},
		}
		for i := 0; i < nOld; i++ {
			p.Old = append(p.Old, Stop{
				ID:    fmt.Sprintf("old%d", i),
				Pos:   Point{rng.Float64() * 50, rng.Float64() * 50},
				Load:  rng.Float64() * 2,
				Ready: 0,
				Due:   rng.Float64() * 200,
			})
		}
		for j := 0; j < nOrders; j++ {
			load := 1 + rng.Float64()*2
			order := fmt.Sprintf("new%d", j)
			p.New = append(p.New,
				Stop{ID: order + "P", Pos: Point{rng.Float64() * 50, rng.Float64() * 50},
					Load: load, Ready: 0, Due: rng.Float64() * 200, Order: order, Kind: Pickup},
				Stop{ID: order + "D", Pos: Point{rng.Float64() * 50, rng.Float64() * 50},
					Load: -load, Ready: 0, Due: rng.Float64() * 200, Order: order, Kind: Delivery},
			)
		}
		if err := func() (err error) {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("panic: %v", r)
				}
			}()
			crossCheck(t, p)
			return nil
		}(); err != nil {
			t.Fatalf("iter %d: %v", iter, err)
		}
		if t.Failed() {
			t.Fatalf("iter %d failed for problem %+v", iter, p)
		}
	}
}

func TestTwentyOldStops(t *testing.T) {
	p := Problem{
		Vehicle: Vehicle{Capacity: 4, Start: Point{0, 0}, Speed: 1},
	}
	for i := 0; i < 20; i++ {
		p.Old = append(p.Old, looseStop(fmt.Sprintf("S%d", i), float64(i*10), 0))
	}
	p.New = []Stop{
		{ID: "P", Pos: Point{55, 30}, Load: 2, Ready: 0, Due: 1000, Order: "o", Kind: Pickup},
		{ID: "D", Pos: Point{145, 30}, Load: -2, Ready: 0, Due: 1000, Order: "o", Kind: Delivery},
	}
	crossCheck(t, p)
	res := Solve(p)
	if !res.Feasible {
		t.Fatalf("expected feasible, got %v", res.Violations)
	}
}
