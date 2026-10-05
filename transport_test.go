package transport

import (
	"errors"
	"math"
	"math/rand"
	"testing"
)

// sampleProblem builds a deterministic instance exercising every
// feature: two scenarios with different capacities and travel times,
// per-line fixed costs, two shared temperature zones, time windows and
// a predecessor constraint.
func sampleProblem() *Problem {
	orders := []Order{
		{ID: "A", Size: 3, Zone: "frozen", Earliest: 0, Latest: 10, Predecessor: -1},
		{ID: "B", Size: 2, Zone: "frozen", Earliest: 1, Latest: 9, Predecessor: 0},
		{ID: "C", Size: 4, Zone: "fresh", Earliest: 0, Latest: 12, Predecessor: -1},
		{ID: "D", Size: 1, Zone: "fresh", Earliest: 2, Latest: 11, Predecessor: -1},
		{ID: "E", Size: 2, Zone: "fresh", Earliest: 0, Latest: 8, Predecessor: 2},
	}
	lines := []Line{
		{ID: "L1", FixedCost: 5, Capacity: [2]float64{8, 6}},
		{ID: "L2", FixedCost: 3, Capacity: [2]float64{5, 7}},
		{ID: "L3", FixedCost: 8, Capacity: [2]float64{10, 10}},
	}
	p := &Problem{
		Orders: orders,
		Lines:  lines,
		ZoneCapacity: map[string][2]float64{
			"frozen": {6, 5},
			"fresh":  {8, 7},
		},
	}
	travel := [2][][]float64{
		{ // scenario 0 arrival times
			{2, 4, 1}, // order A on L1, L2, L3
			{5, 3, 6},
			{3, 7, 2},
			{6, 2, 5},
			{4, 6, 3},
		},
		{ // scenario 1: different arrival times
			{3, 2, 4},
			{6, 5, 3},
			{2, 5, 6},
			{7, 3, 4},
			{5, 4, 7},
		},
	}
	cost := [2][][]float64{
		{
			{1, 2, 3},
			{2, 1, 2},
			{3, 2, 1},
			{1, 3, 2},
			{2, 2, 4},
		},
		{
			{2, 1, 2},
			{3, 2, 1},
			{1, 3, 2},
			{2, 1, 3},
			{3, 2, 2},
		},
	}
	p.Travel = travel
	p.Cost = cost
	return p
}

func TestSolveMatchesEnumeration(t *testing.T) {
	p := sampleProblem()
	res, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	enum, err := Enumerate(p)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if enum.Total != int(math.Pow(float64(len(p.Lines)), float64(len(p.Orders)))) {
		t.Fatalf("enumeration total = %d, want %d", enum.Total, 3*3*3*3*3)
	}
	if enum.Feasible == 0 {
		t.Fatal("sample problem unexpectedly infeasible")
	}
	if math.Abs(res.Objective-enum.Best) > 1e-9 {
		t.Fatalf("Solve objective %v != enumeration optimum %v", res.Objective, enum.Best)
	}
	// Completed search: best lower bound certifies the incumbent.
	if math.Abs(res.Trace.BestLower-res.Trace.BestUpper) > 1e-9 {
		t.Fatalf("bounds do not close: lower %v upper %v", res.Trace.BestLower, res.Trace.BestUpper)
	}
	if math.Abs(res.Objective-math.Max(res.ScenarioCost[0], res.ScenarioCost[1])) > 1e-9 {
		t.Fatalf("objective %v != max scenario cost %v", res.Objective, res.ScenarioCost)
	}
	if err := VerifyCertificate(p, res.Assignment, res.Certificate); err != nil {
		t.Fatalf("certificate: %v", err)
	}
	if !p.Feasible(res.Assignment) {
		t.Fatal("solver returned an infeasible assignment")
	}
}

func TestRandomizedAgainstEnumeration(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	zones := []string{"frozen", "fresh", "dry"}
	for trial := 0; trial < 60; trial++ {
		n := 2 + rng.Intn(5) // 2..6 orders
		m := 2 + rng.Intn(3) // 2..4 lines
		p := &Problem{ZoneCapacity: map[string][2]float64{}}
		for i := 0; i < n; i++ {
			pred := -1
			if i > 0 && rng.Intn(3) == 0 {
				pred = rng.Intn(i)
			}
			p.Orders = append(p.Orders, Order{
				ID:          string(rune('A' + i)),
				Size:        1 + float64(rng.Intn(4)),
				Zone:        zones[rng.Intn(len(zones))],
				Earliest:    0,
				Latest:      6 + float64(rng.Intn(6)),
				Predecessor: pred,
			})
		}
		for j := 0; j < m; j++ {
			p.Lines = append(p.Lines, Line{
				ID:        string(rune('a' + j)),
				FixedCost: float64(rng.Intn(6)),
				Capacity:  [2]float64{4 + float64(rng.Intn(8)), 4 + float64(rng.Intn(8))},
			})
		}
		for _, z := range zones {
			p.ZoneCapacity[z] = [2]float64{5 + float64(rng.Intn(8)), 5 + float64(rng.Intn(8))}
		}
		for s := 0; s < ScenarioCount; s++ {
			p.Travel[s] = make([][]float64, n)
			p.Cost[s] = make([][]float64, n)
			for i := 0; i < n; i++ {
				p.Travel[s][i] = make([]float64, m)
				p.Cost[s][i] = make([]float64, m)
				for j := 0; j < m; j++ {
					p.Travel[s][i][j] = float64(rng.Intn(10))
					p.Cost[s][i][j] = float64(rng.Intn(5))
				}
			}
		}
		res, serr := Solve(p)
		enum, eerr := Enumerate(p)
		if eerr != nil {
			t.Fatalf("trial %d: Enumerate: %v", trial, eerr)
		}
		if enum.Feasible == 0 {
			if !errors.Is(serr, ErrInfeasible) {
				t.Fatalf("trial %d: infeasible by enumeration, Solve err = %v", trial, serr)
			}
			continue
		}
		if serr != nil {
			t.Fatalf("trial %d: Solve: %v (enumeration found %d feasible)", trial, serr, enum.Feasible)
		}
		if math.Abs(res.Objective-enum.Best) > 1e-9 {
			t.Fatalf("trial %d: Solve %v != enumeration %v", trial, res.Objective, enum.Best)
		}
		if math.Abs(res.Trace.BestLower-res.Trace.BestUpper) > 1e-9 {
			t.Fatalf("trial %d: bounds do not close: %v vs %v", trial, res.Trace.BestLower, res.Trace.BestUpper)
		}
		if err := VerifyCertificate(p, res.Assignment, res.Certificate); err != nil {
			t.Fatalf("trial %d: certificate: %v", trial, err)
		}
	}
}

func TestCertificateTamperDetected(t *testing.T) {
	p := sampleProblem()
	res, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	bad := *res.Certificate
	bad.Objective = res.Certificate.Objective - 1
	if err := VerifyCertificate(p, res.Assignment, &bad); err == nil {
		t.Fatal("tampered objective accepted")
	}
	bad2 := *res.Certificate
	bad2.Lines = append([]LineCertificate(nil), res.Certificate.Lines...)
	bad2.Lines[0].Scenario[0].Load += 1
	if err := VerifyCertificate(p, res.Assignment, &bad2); err == nil {
		t.Fatal("tampered line load accepted")
	}
}

func TestScenarioSpecificTimeWindows(t *testing.T) {
	// Order X fits its window on L1 only in scenario 0 and on L2 only
	// in scenario 1, so no single line works: instance is infeasible.
	p := &Problem{
		Orders: []Order{
			{ID: "X", Size: 1, Zone: "z", Earliest: 0, Latest: 5, Predecessor: -1},
		},
		Lines: []Line{
			{ID: "L1", FixedCost: 0, Capacity: [2]float64{10, 10}},
			{ID: "L2", FixedCost: 0, Capacity: [2]float64{10, 10}},
		},
		ZoneCapacity: map[string][2]float64{"z": {10, 10}},
		Travel: [2][][]float64{
			{{3, 9}}, // scenario 0: L1 ok, L2 too late
			{{9, 4}}, // scenario 1: L1 too late, L2 ok
		},
		Cost: [2][][]float64{
			{{1, 1}},
			{{1, 1}},
		},
	}
	if _, err := Solve(p); !errors.Is(err, ErrInfeasible) {
		t.Fatalf("expected ErrInfeasible, got %v", err)
	}
	enum, err := Enumerate(p)
	if err != nil {
		t.Fatal(err)
	}
	if enum.Feasible != 0 {
		t.Fatalf("enumeration found %d feasible, want 0", enum.Feasible)
	}
}

func TestPredecessorAcrossScenarios(t *testing.T) {
	// P must arrive no later than Q in both scenarios. Serving both on
	// L1 violates scenario 1; both on L2 violates scenario 0; the only
	// feasible plan is P on L1 and Q on L2.
	p := &Problem{
		Orders: []Order{
			{ID: "P", Size: 1, Zone: "z", Earliest: 0, Latest: 10, Predecessor: -1},
			{ID: "Q", Size: 1, Zone: "z", Earliest: 0, Latest: 10, Predecessor: 0},
		},
		Lines: []Line{
			{ID: "L1", FixedCost: 1, Capacity: [2]float64{10, 10}},
			{ID: "L2", FixedCost: 1, Capacity: [2]float64{10, 10}},
		},
		ZoneCapacity: map[string][2]float64{"z": {10, 10}},
		Travel: [2][][]float64{
			{{2, 6}, {5, 3}}, // scenario 0: P arrives 2 (L1) / 6 (L2); Q 5 / 3
			{{4, 1}, {3, 8}}, // scenario 1: P arrives 4 (L1) / 1 (L2); Q 3 / 8
		},
		Cost: [2][][]float64{
			{{1, 1}, {1, 1}},
			{{1, 1}, {1, 1}},
		},
	}
	res, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if res.Assignment[0] != 0 || res.Assignment[1] != 1 {
		t.Fatalf("assignment = %v, want P->L1 Q->L2", res.Assignment)
	}
	if !res.Certificate.PredecessorOK[0] || !res.Certificate.PredecessorOK[1] {
		t.Fatal("certificate reports predecessor violation")
	}
}

func TestFrontierNonDominated(t *testing.T) {
	p := sampleProblem()
	res, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if len(res.Trace.Frontier) == 0 {
		t.Fatal("empty frontier")
	}
	for i := 0; i < len(res.Trace.Frontier); i++ {
		for j := 0; j < len(res.Trace.Frontier); j++ {
			if i == j {
				continue
			}
			a, b := res.Trace.Frontier[i], res.Trace.Frontier[j]
			if a.ScenarioCost[0] <= b.ScenarioCost[0] && a.ScenarioCost[1] <= b.ScenarioCost[1] {
				t.Fatalf("frontier point %v dominates %v", a, b)
			}
		}
	}
}

func TestSizeLimits(t *testing.T) {
	p := sampleProblem()
	for len(p.Orders) < MaxOrders+1 {
		p.Orders = append(p.Orders, p.Orders[0])
	}
	if _, err := Solve(p); err == nil {
		t.Fatal("9 orders accepted")
	}
	p = sampleProblem()
	for len(p.Lines) < MaxLines+1 {
		p.Lines = append(p.Lines, p.Lines[0])
	}
	if _, err := Solve(p); err == nil {
		t.Fatal("7 lines accepted")
	}
}
