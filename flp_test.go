package flp_test

import (
	"math"
	"math/rand"
	"testing"

	"flp"
)

// bruteForce is an independent reference solver: it enumerates every open
// subset and every indivisible assignment with no pruning.
func bruteForce(inst flp.Instance) (float64, bool) {
	n, m := len(inst.Sites), len(inst.Demands)
	dist := make([][]float64, n)
	for i, s := range inst.Sites {
		dist[i] = make([]float64, m)
		for j, d := range inst.Demands {
			dist[i][j] = math.Hypot(s.X-d.X, s.Y-d.Y)
		}
	}
	best := math.Inf(1)
	for mask := 0; mask < 1<<uint(n); mask++ {
		var open []int
		openCost := 0.0
		for i := 0; i < n; i++ {
			if mask>>uint(i)&1 == 1 {
				open = append(open, i)
				openCost += inst.Sites[i].OpenCost
			}
		}
		if openCost >= best {
			continue
		}
		rem := make([]int, n)
		for _, i := range open {
			rem[i] = inst.Sites[i].Capacity
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
			d := inst.Demands[j]
			for _, i := range open {
				if dist[i][j] > inst.MaxDist+1e-9 || rem[i] < d.Amount {
					continue
				}
				rem[i] -= d.Amount
				rec(j+1, cost+float64(d.Amount)*dist[i][j])
				rem[i] += d.Amount
			}
		}
		rec(0, 0)
	}
	return best, !math.IsInf(best, 1)
}

func sampleInstance() flp.Instance {
	return flp.Instance{
		Sites: []flp.Site{
			{ID: "S1", OpenCost: 10, Capacity: 7, X: 0, Y: 0},
			{ID: "S2", OpenCost: 8, Capacity: 5, X: 4, Y: 0},
			{ID: "S3", OpenCost: 12, Capacity: 12, X: 2, Y: 3},
		},
		Demands: []flp.Demand{
			{ID: "D1", Amount: 4, X: 0.5, Y: 0.5},
			{ID: "D2", Amount: 3, X: 3.5, Y: 0.5},
			{ID: "D3", Amount: 2, X: 2, Y: 2.5},
			{ID: "D4", Amount: 5, X: 1, Y: 1},
		},
		MaxDist: 6,
	}
}

// bruteForceMask is bruteForce restricted to one fixed open mask.
func bruteForceMask(inst flp.Instance, mask int) (float64, bool) {
	n, m := len(inst.Sites), len(inst.Demands)
	dist := make([][]float64, n)
	for i, s := range inst.Sites {
		dist[i] = make([]float64, m)
		for j, d := range inst.Demands {
			dist[i][j] = math.Hypot(s.X-d.X, s.Y-d.Y)
		}
	}
	var open []int
	openCost := 0.0
	for i := 0; i < n; i++ {
		if mask>>uint(i)&1 == 1 {
			open = append(open, i)
			openCost += inst.Sites[i].OpenCost
		}
	}
	rem := make([]int, n)
	for _, i := range open {
		rem[i] = inst.Sites[i].Capacity
	}
	best := math.Inf(1)
	var rec func(j int, cost float64)
	rec = func(j int, cost float64) {
		if j == m {
			if openCost+cost < best {
				best = openCost + cost
			}
			return
		}
		d := inst.Demands[j]
		for _, i := range open {
			if dist[i][j] > inst.MaxDist+1e-9 || rem[i] < d.Amount {
				continue
			}
			rem[i] -= d.Amount
			rec(j+1, cost+float64(d.Amount)*dist[i][j])
			rem[i] += d.Amount
		}
	}
	rec(0, 0)
	return best, !math.IsInf(best, 1)
}

func TestSolveMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 30; trial++ {
		n := 2 + rng.Intn(4) // 2..5 sites
		m := 2 + rng.Intn(5) // 2..6 demands
		inst := flp.Instance{MaxDist: 3 + rng.Float64()*7}
		for i := 0; i < n; i++ {
			inst.Sites = append(inst.Sites, flp.Site{
				ID:       string(rune('A' + i)),
				OpenCost: float64(rng.Intn(20)),
				Capacity: 3 + rng.Intn(12),
				X:        rng.Float64() * 10,
				Y:        rng.Float64() * 10,
			})
		}
		for j := 0; j < m; j++ {
			inst.Demands = append(inst.Demands, flp.Demand{
				ID:     string(rune('a' + j)),
				Amount: 1 + rng.Intn(5),
				X:      rng.Float64() * 10,
				Y:      rng.Float64() * 10,
			})
		}
		res, err := flp.Solve(inst, -1)
		if err != nil {
			t.Fatalf("trial %d: Solve error: %v", trial, err)
		}
		want, ok := bruteForce(inst)
		if ok != res.Feasible {
			t.Fatalf("trial %d: feasibility mismatch: got %v want %v", trial, res.Feasible, ok)
		}
		if !ok {
			continue
		}
		if math.Abs(res.TotalCost-want) > 1e-9 {
			t.Fatalf("trial %d: cost mismatch: got %.12g want %.12g", trial, res.TotalCost, want)
		}
		if err := res.Verify(inst); err != nil {
			t.Fatalf("trial %d: certificate invalid: %v", trial, err)
		}
		if res.LowerBound > res.TotalCost+1e-9 {
			t.Fatalf("trial %d: lower bound %.12g exceeds optimum %.12g", trial, res.LowerBound, res.TotalCost)
		}
	}
}

// TestAllOpenAssignment forces every site open and checks the indivisible
// assignment against the brute-force optimum on the same fixed open set.
func TestAllOpenAssignment(t *testing.T) {
	inst := sampleInstance()
	open := make([]bool, len(inst.Sites))
	for i := range open {
		open[i] = true
	}
	res, err := flp.AssignOptimal(inst, open)
	if err != nil {
		t.Fatalf("AssignOptimal: %v", err)
	}
	if !res.Feasible {
		t.Fatalf("expected feasible, got reason %q", res.Reason)
	}
	// Reference: brute force restricted to the all-open mask.
	want, ok := bruteForceMask(inst, 1<<uint(len(inst.Sites))-1)
	if !ok {
		t.Fatal("brute force says infeasible")
	}
	if math.Abs(res.TotalCost-want) > 1e-9 {
		t.Fatalf("all-open cost mismatch: got %.12g want %.12g", res.TotalCost, want)
	}
	if len(res.OpenSites) != len(inst.Sites) {
		t.Fatalf("expected all %d sites open, got %d", len(inst.Sites), len(res.OpenSites))
	}
	// Each demand assigned whole exactly once.
	count := map[string]int{}
	for _, a := range res.Assignments {
		count[a.DemandID]++
		for _, d := range inst.Demands {
			if d.ID == a.DemandID && a.Amount != d.Amount {
				t.Fatalf("demand %s split: %d of %d", d.ID, a.Amount, d.Amount)
			}
		}
	}
	for _, d := range inst.Demands {
		if count[d.ID] != 1 {
			t.Fatalf("demand %s assigned %d times", d.ID, count[d.ID])
		}
	}
	if err := res.Verify(inst); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
}

func TestCapacityCertificate(t *testing.T) {
	inst := sampleInstance()
	res, err := flp.Solve(inst, -1)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible {
		t.Fatalf("infeasible: %s", res.Reason)
	}
	totalUsed := 0
	for _, c := range res.Certificates {
		if c.Remaining != c.Capacity-c.Used {
			t.Fatalf("site %s: remaining %d != capacity %d - used %d", c.SiteID, c.Remaining, c.Capacity, c.Used)
		}
		if c.Remaining < 0 {
			t.Fatalf("site %s: negative remaining capacity", c.SiteID)
		}
		sum := 0
		for _, id := range c.DemandIDs {
			for _, d := range inst.Demands {
				if d.ID == id {
					sum += d.Amount
				}
			}
		}
		if sum != c.Used {
			t.Fatalf("site %s: demands sum %d != used %d", c.SiteID, sum, c.Used)
		}
		totalUsed += c.Used
	}
	totalDemand := 0
	for _, d := range inst.Demands {
		totalDemand += d.Amount
	}
	if totalUsed != totalDemand {
		t.Fatalf("certificates cover %d of %d total demand", totalUsed, totalDemand)
	}
	if err := res.Verify(inst); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestBudgetBound(t *testing.T) {
	inst := sampleInstance()
	opt, err := flp.Solve(inst, -1)
	if err != nil || !opt.Feasible {
		t.Fatalf("solve: %v %v", opt, err)
	}
	// Budget below the optimum must be rejected, with a valid bound.
	under, err := flp.Solve(inst, opt.TotalCost-0.5)
	if err != nil {
		t.Fatal(err)
	}
	if under.BudgetOK {
		t.Fatal("expected budget verdict false for tight budget")
	}
	if under.LowerBound > under.Budget+1e-9 {
		// Lower bound alone already certifies the budget is too small.
		if under.Reason == "" {
			t.Fatal("expected a reason citing the bound")
		}
	}
	if under.LowerBound > opt.TotalCost+1e-9 {
		t.Fatalf("lower bound %.12g exceeds optimum %.12g", under.LowerBound, opt.TotalCost)
	}
	// Budget equal to the optimum must be accepted.
	at, err := flp.Solve(inst, opt.TotalCost)
	if err != nil {
		t.Fatal(err)
	}
	if !at.BudgetOK {
		t.Fatal("expected budget verdict true at the optimum")
	}
	// No budget: verdict defaults to true.
	if !opt.BudgetOK {
		t.Fatal("expected budget verdict true when no budget given")
	}
}

func TestCoverageLimit(t *testing.T) {
	inst := flp.Instance{
		Sites: []flp.Site{
			{ID: "near", OpenCost: 100, Capacity: 10, X: 0, Y: 0},
			{ID: "far", OpenCost: 1, Capacity: 10, X: 50, Y: 0},
		},
		Demands: []flp.Demand{{ID: "d", Amount: 3, X: 1, Y: 0}},
		MaxDist: 5,
	}
	res, err := flp.Solve(inst, -1)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible || len(res.Assignments) != 1 || res.Assignments[0].SiteID != "near" {
		t.Fatalf("expected the expensive near site due to coverage limit, got %+v", res.Assignments)
	}
	// Tighten the limit so nothing covers.
	inst.MaxDist = 0.5
	res, err = flp.Solve(inst, -1)
	if err != nil {
		t.Fatal(err)
	}
	if res.Feasible {
		t.Fatal("expected infeasible when coverage limit excludes all sites")
	}
}

func TestIndivisibleDemand(t *testing.T) {
	// Total capacity 10 >= demand 6, but no single site fits it: splitting
	// is forbidden, so the instance is infeasible.
	inst := flp.Instance{
		Sites: []flp.Site{
			{ID: "A", OpenCost: 1, Capacity: 5, X: 0, Y: 0},
			{ID: "B", OpenCost: 1, Capacity: 5, X: 0, Y: 0},
		},
		Demands: []flp.Demand{{ID: "big", Amount: 6, X: 0, Y: 0}},
		MaxDist: 1,
	}
	res, err := flp.Solve(inst, -1)
	if err != nil {
		t.Fatal(err)
	}
	if res.Feasible {
		t.Fatal("expected infeasible: indivisible demand exceeds every single capacity")
	}
	// Raising one capacity makes it feasible.
	inst.Sites[0].Capacity = 6
	res, err = flp.Solve(inst, -1)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible || len(res.Assignments) != 1 || res.Assignments[0].Amount != 6 {
		t.Fatalf("expected whole demand on one site, got %+v", res.Assignments)
	}
}

func TestVerifyDetectsTampering(t *testing.T) {
	inst := sampleInstance()
	res, err := flp.Solve(inst, -1)
	if err != nil || !res.Feasible {
		t.Fatalf("solve: %v", err)
	}
	if err := res.Verify(inst); err != nil {
		t.Fatalf("honest certificate rejected: %v", err)
	}

	cases := map[string]func(r *flp.Result){
		"wrong site": func(r *flp.Result) {
			for _, s := range inst.Sites {
				if s.ID != r.Assignments[0].SiteID {
					r.Assignments[0].SiteID = s.ID
					return
				}
			}
		},
		"dropped assignment": func(r *flp.Result) {
			r.Assignments = r.Assignments[1:]
		},
		"inflated capacity": func(r *flp.Result) {
			r.Certificates[0].Capacity++
		},
		"wrong total": func(r *flp.Result) {
			r.TotalCost -= 1
		},
		"closed site kept": func(r *flp.Result) {
			r.OpenSites = r.OpenSites[:len(r.OpenSites)-1]
		},
	}
	for name, tamper := range cases {
		bad := res
		bad.Assignments = append([]flp.Assignment(nil), res.Assignments...)
		bad.Certificates = append([]flp.SiteCertificate(nil), res.Certificates...)
		bad.OpenSites = append([]string(nil), res.OpenSites...)
		tamper(&bad)
		if err := bad.Verify(inst); err == nil {
			t.Fatalf("tampered certificate (%s) passed verification", name)
		}
	}
}

func TestMaxSizeInstance(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	inst := flp.Instance{MaxDist: 15}
	for i := 0; i < flp.MaxSites; i++ {
		inst.Sites = append(inst.Sites, flp.Site{
			ID:       "S" + string(rune('A'+i)),
			OpenCost: float64(1 + rng.Intn(30)),
			Capacity: 8 + rng.Intn(10),
			X:        rng.Float64() * 10,
			Y:        rng.Float64() * 10,
		})
	}
	for j := 0; j < flp.MaxDemands; j++ {
		inst.Demands = append(inst.Demands, flp.Demand{
			ID:     "D" + string(rune('a'+j)),
			Amount: 1 + rng.Intn(4),
			X:      rng.Float64() * 10,
			Y:      rng.Float64() * 10,
		})
	}
	res, err := flp.Solve(inst, -1)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Feasible {
		t.Fatalf("expected feasible, got %q", res.Reason)
	}
	if err := res.Verify(inst); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
}

func TestValidate(t *testing.T) {
	inst := sampleInstance()
	inst.Sites = append(inst.Sites, inst.Sites[0])
	if _, err := flp.Solve(inst, -1); err == nil {
		t.Fatal("expected duplicate site id error")
	}
	inst = sampleInstance()
	inst.Demands[0].Amount = 0
	if _, err := flp.Solve(inst, -1); err == nil {
		t.Fatal("expected non-positive amount error")
	}
	inst = sampleInstance()
	inst.MaxDist = -1
	if _, err := flp.Solve(inst, -1); err == nil {
		t.Fatal("expected negative max_dist error")
	}
	inst = sampleInstance()
	for len(inst.Sites) <= flp.MaxSites {
		inst.Sites = append(inst.Sites, flp.Site{ID: string(rune('a' + len(inst.Sites))), Capacity: 1})
	}
	if _, err := flp.Solve(inst, -1); err == nil {
		t.Fatal("expected too-many-sites error")
	}
}
