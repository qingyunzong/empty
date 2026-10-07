package location

import (
	"math"
	"math/rand"
	"testing"
)

// bruteForce is an independent reference: enumerate every open subset and
// every unsplittable assignment, returning the minimum total cost.
func bruteForce(inst Instance) (float64, bool) {
	n, m := len(inst.Sites), len(inst.Demands)
	el := make([][]int, m)
	for j, d := range inst.Demands {
		for i, s := range inst.Sites {
			if dist(d.X, d.Y, s.X, s.Y) <= inst.MaxDist {
				el[j] = append(el[j], i)
			}
		}
	}
	best := math.Inf(1)
	for mask := 1; mask < (1 << n); mask++ {
		openCost := 0.0
		capLeft := make([]int, n)
		for i := 0; i < n; i++ {
			capLeft[i] = inst.Sites[i].Capacity
			if mask&(1<<i) != 0 {
				openCost += inst.Sites[i].OpenCost
			}
		}
		if openCost >= best {
			continue
		}
		var rec func(j int, cost float64)
		rec = func(j int, cost float64) {
			if openCost+cost >= best {
				return
			}
			if j == m {
				best = openCost + cost
				return
			}
			for _, i := range el[j] {
				if mask&(1<<i) == 0 || capLeft[i] < inst.Demands[j].Size {
					continue
				}
				capLeft[i] -= inst.Demands[j].Size
				rec(j+1, cost+dist(inst.Demands[j].X, inst.Demands[j].Y, inst.Sites[i].X, inst.Sites[i].Y))
				capLeft[i] += inst.Demands[j].Size
			}
		}
		rec(0, 0)
	}
	return best, !math.IsInf(best, 1)
}

// TestAllOpenSmallExample: capacities force every site to open; the
// assignment cost is verified against the brute-force reference.
func TestAllOpenSmallExample(t *testing.T) {
	inst := Instance{
		Sites: []Site{
			{ID: 0, X: 0, Y: 0, OpenCost: 10, Capacity: 3},
			{ID: 1, X: 10, Y: 0, OpenCost: 10, Capacity: 3},
			{ID: 2, X: 5, Y: 8, OpenCost: 10, Capacity: 4},
		},
		Demands: []Demand{
			{ID: 0, X: 1, Y: 0, Size: 2},
			{ID: 1, X: 9, Y: 1, Size: 2},
			{ID: 2, X: 5, Y: 7, Size: 2},
			{ID: 3, X: 6, Y: 7, Size: 2},
		},
		MaxDist: 20,
	}
	sol, err := Solve(inst)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	for i := range inst.Sites {
		if !sol.Open[i] {
			t.Fatalf("site %d must be open (total capacity forces all-open)", i)
		}
	}
	want, ok := bruteForce(inst)
	if !ok {
		t.Fatal("brute force says infeasible")
	}
	if math.Abs(sol.TotalCost-want) > 1e-9 {
		t.Fatalf("total cost %.6f, brute force %.6f", sol.TotalCost, want)
	}
	if err := Verify(inst, sol); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
}

// TestBruteForceCrossCheck compares Solve with the brute-force reference on
// randomized small instances, and checks the bound and certificate.
func TestBruteForceCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		n := 1 + rng.Intn(5)
		m := 1 + rng.Intn(4)
		inst := Instance{MaxDist: 8 + rng.Float64()*8}
		for i := 0; i < n; i++ {
			inst.Sites = append(inst.Sites, Site{
				ID: i, X: rng.Float64() * 10, Y: rng.Float64() * 10,
				OpenCost: rng.Float64() * 20, Capacity: 1 + rng.Intn(5),
			})
		}
		for j := 0; j < m; j++ {
			inst.Demands = append(inst.Demands, Demand{
				ID: j, X: rng.Float64() * 10, Y: rng.Float64() * 10,
				Size: 1 + rng.Intn(3),
			})
		}
		want, feasible := bruteForce(inst)
		sol, err := Solve(inst)
		if !feasible {
			if err == nil {
				t.Fatalf("trial %d: expected infeasible, got cost %.6f", trial, sol.TotalCost)
			}
			continue
		}
		if err != nil {
			t.Fatalf("trial %d: Solve: %v", trial, err)
		}
		if math.Abs(sol.TotalCost-want) > 1e-9 {
			t.Fatalf("trial %d: cost %.6f, brute force %.6f", trial, sol.TotalCost, want)
		}
		if sol.LowerBound > sol.TotalCost+1e-9 {
			t.Fatalf("trial %d: lower bound %.6f exceeds optimum %.6f", trial, sol.LowerBound, sol.TotalCost)
		}
		if err := Verify(inst, sol); err != nil {
			t.Fatalf("trial %d: certificate invalid: %v", trial, err)
		}
	}
}

// TestCapacityCertificate ensures Verify accepts the optimum and rejects
// tampered certificates.
func TestCapacityCertificate(t *testing.T) {
	inst := Instance{
		Sites: []Site{
			{ID: 0, X: 0, Y: 0, OpenCost: 5, Capacity: 2},
			{ID: 1, X: 3, Y: 0, OpenCost: 5, Capacity: 2},
		},
		Demands: []Demand{
			{ID: 0, X: 0, Y: 1, Size: 2},
			{ID: 1, X: 3, Y: 1, Size: 2},
		},
		MaxDist: 5,
	}
	sol, err := Solve(inst)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if err := Verify(inst, sol); err != nil {
		t.Fatalf("valid certificate rejected: %v", err)
	}

	// Overload site 0 with both demands.
	bad := Solution{
		Open: []bool{true, false}, Assign: []int{0, 0}, Load: []int{4, 0},
		OpenCost: 5, AssignCost: sol.AssignCost, TotalCost: 5 + sol.AssignCost,
	}
	if err := Verify(inst, bad); err == nil {
		t.Fatal("overloaded certificate accepted")
	}

	// Assign demand 1 to closed site 1.
	bad2 := sol
	bad2.Assign = []int{sol.Assign[0], 1}
	bad2.Open = []bool{true, false}
	if err := Verify(inst, bad2); err == nil {
		t.Fatal("certificate with closed-site assignment accepted")
	}

	// Coverage violation: tighten the limit below the assigned distance.
	tight := inst
	tight.MaxDist = 0.5
	if err := Verify(tight, sol); err == nil {
		t.Fatal("certificate violating coverage limit accepted")
	}
}

// TestBudgetBound checks the finite-budget bound reporting.
func TestBudgetBound(t *testing.T) {
	inst := Instance{
		Sites: []Site{
			{ID: 0, X: 0, Y: 0, OpenCost: 10, Capacity: 4},
			{ID: 1, X: 6, Y: 0, OpenCost: 4, Capacity: 4},
		},
		Demands: []Demand{
			{ID: 0, X: 0, Y: 0, Size: 2},
			{ID: 1, X: 6, Y: 0, Size: 2},
		},
		MaxDist: 10,
	}
	sol, err := Solve(inst)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if sol.HasBudget {
		t.Fatal("no budget set, HasBudget must be false")
	}

	under := inst
	under.Budget = sol.TotalCost - 1e-6
	solUnder, err := Solve(under)
	if err != nil {
		t.Fatalf("Solve under budget: %v", err)
	}
	if !solUnder.HasBudget || solUnder.WithinBudget {
		t.Fatal("tight budget must be reported as exceeded")
	}
	if solUnder.LowerBound > solUnder.TotalCost+1e-9 {
		t.Fatal("lower bound exceeds optimum")
	}

	over := inst
	over.Budget = sol.TotalCost + 1
	solOver, err := Solve(over)
	if err != nil {
		t.Fatalf("Solve over budget: %v", err)
	}
	if !solOver.WithinBudget {
		t.Fatal("ample budget must be reported as within budget")
	}
}

// TestInfeasibleCoverage: a demand beyond every site's coverage limit makes
// the instance infeasible.
func TestInfeasibleCoverage(t *testing.T) {
	inst := Instance{
		Sites:   []Site{{ID: 0, X: 0, Y: 0, OpenCost: 1, Capacity: 10}},
		Demands: []Demand{{ID: 0, X: 100, Y: 0, Size: 1}},
		MaxDist: 5,
	}
	if _, err := Solve(inst); err != ErrInfeasible {
		t.Fatalf("expected ErrInfeasible, got %v", err)
	}
}

// TestUnsplittable: a size-2 demand cannot be split across two capacity-1
// sites; only the capacity-2 site can serve it.
func TestUnsplittable(t *testing.T) {
	inst := Instance{
		Sites: []Site{
			{ID: 0, X: 0, Y: 0, OpenCost: 1, Capacity: 1},
			{ID: 1, X: 0, Y: 1, OpenCost: 1, Capacity: 1},
			{ID: 2, X: 0, Y: 2, OpenCost: 1, Capacity: 2},
		},
		Demands: []Demand{{ID: 0, X: 0, Y: 0, Size: 2}},
		MaxDist: 100,
	}
	sol, err := Solve(inst)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if sol.Assign[0] != 2 {
		t.Fatalf("size-2 demand must go to the capacity-2 site, got site %d", sol.Assign[0])
	}
	if err := Verify(inst, sol); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
}
