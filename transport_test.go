package transport

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

func baseProblem() *Problem {
	return &Problem{
		Orders: []Order{
			{ID: 0, Demand: 2, Zone: 0, Window: TimeWindow{0, 10}},
			{ID: 1, Demand: 3, Zone: 0, Window: TimeWindow{0, 10}},
			{ID: 2, Demand: 1, Zone: 1, Window: TimeWindow{0, 10}},
		},
		Lines: []Line{
			{ID: 0, Capacity: [2]int{5, 4}, FixedCost: 7, Zone: 0, Travel: [2]int{3, 4}},
			{ID: 1, Capacity: [2]int{2, 2}, FixedCost: 1, Zone: 1, Travel: [2]int{5, 6}},
		},
		AssignCost: [][][2]int{
			{{1, 2}, {9, 9}},
			{{2, 1}, {9, 9}},
			{{9, 9}, {1, 1}},
		},
		ZoneCap: []int{10, 10},
	}
}

func TestValidateLimits(t *testing.T) {
	p := baseProblem()
	if err := p.Validate(); err != nil {
		t.Fatalf("valid problem rejected: %v", err)
	}
	big := baseProblem()
	big.Orders = make([]Order, MaxOrders+1)
	for i := range big.Orders {
		big.Orders[i] = Order{ID: i, Demand: 1, Zone: 0, Window: TimeWindow{0, 1}}
	}
	if err := big.Validate(); err == nil {
		t.Fatal("expected order-limit error")
	}
	wide := baseProblem()
	wide.Lines = make([]Line, MaxLines+1)
	if err := wide.Validate(); err == nil {
		t.Fatal("expected line-limit error")
	}
}

func TestEnumerateCountsAllAssignments(t *testing.T) {
	p := baseProblem()
	res := Enumerate(p)
	if res.Total != 8 { // 2 lines ^ 3 orders
		t.Fatalf("Total = %d, want 8", res.Total)
	}
}

func TestDualScenarioCapacityCertificate(t *testing.T) {
	p := baseProblem()
	// Orders 0,1 on line 0: load 5 fits scenario 0 (cap 5) but not
	// scenario 1 (cap 4). The certificate must flag scenario 1.
	cert := p.Certify([]int{0, 0, 1})
	if cert.Feasible {
		t.Fatal("expected infeasible certificate")
	}
	found := false
	for _, v := range cert.Violations {
		if want := "line 0 overloaded in scenario 1: 5 > 4"; v == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing scenario-1 overload violation, got %v", cert.Violations)
	}
	if cert.Lines[0].Load != [2]int{5, 5} || cert.Lines[0].Capacity != [2]int{5, 4} {
		t.Fatalf("bad per-line certificate: %+v", cert.Lines[0])
	}
	// Zone 0 has only line 0, so orders 0 and 1 must share it; their joint
	// load 5 exceeds scenario-1 capacity 4, hence the whole instance is
	// infeasible and enumeration must agree.
	res := Enumerate(p)
	if res.Feasible != 0 || res.Found {
		t.Fatalf("expected infeasible instance, got %+v", res)
	}
	if got := Solve(p); got.Found {
		t.Fatalf("solver reported solution on infeasible instance: %+v", got)
	}
}

func TestScenarioDependentTimeWindows(t *testing.T) {
	p := baseProblem()
	p.Lines[0].Capacity = [2]int{6, 6} // isolate the time-window constraint
	// Line 0 arrives at t=3 in scenario 0 but t=8 in scenario 1; order 0
	// only accepts arrivals up to t=5.
	p.Orders[0].Window = TimeWindow{0, 5}
	p.Lines[0].Travel = [2]int{3, 8}
	if p.Feasible([]int{0, 0, 1}) {
		t.Fatal("assignment should violate scenario-1 time window")
	}
	// Widen the window: now both scenarios are legal for the same plan.
	p.Orders[0].Window = TimeWindow{0, 8}
	p.Orders[1].Window = TimeWindow{0, 8}
	if !p.Feasible([]int{0, 0, 1}) {
		t.Fatalf("assignment should be feasible, violations: %v", p.Check([]int{0, 0, 1}))
	}
}

func TestFixedCostAndSharedZoneCapacity(t *testing.T) {
	p := baseProblem()
	p.ZoneCap = []int{3, 10} // zone 0 shared pool fits only one of the two orders
	if p.Feasible([]int{0, 0, 1}) {
		t.Fatal("shared zone capacity must be enforced")
	}
	p.ZoneCap = []int{10, 10}
	c := p.Costs([]int{0, 0, 1})
	// Line 0 fixed 7 once + order costs 1+2 (s0) / 2+1 (s1); line 1 fixed 1 + 1.
	if want := [2]int{7 + 1 + 2 + 1 + 1, 7 + 2 + 1 + 1 + 1}; c != want {
		t.Fatalf("costs = %v, want %v", c, want)
	}
}

func TestPrecedence(t *testing.T) {
	p := baseProblem()
	p.Lines[0].Capacity = [2]int{6, 6} // isolate the precedence constraint
	// Order 2 (line 1, arrives 5/6) must precede order 0 (line 0, 3/4):
	// impossible while order 0 uses line 0.
	p.Precedence = [][2]int{{2, 0}}
	if p.Feasible([]int{0, 0, 1}) {
		t.Fatal("precedence 2->0 must be violated")
	}
	p.Precedence = [][2]int{{0, 2}}
	if !p.Feasible([]int{0, 0, 1}) {
		t.Fatal("precedence 0->2 should hold")
	}
}

func frontierKeys(f []FrontierPoint) []string {
	keys := make([]string, 0, len(f))
	seen := map[[2]int]bool{}
	for _, pt := range f {
		if seen[pt.Cost] {
			continue
		}
		seen[pt.Cost] = true
		keys = append(keys, string(rune(pt.Cost[0]))+","+string(rune(pt.Cost[1])))
	}
	sort.Strings(keys)
	return keys
}

func randomProblem(r *rand.Rand, n, m, zones int) *Problem {
	p := &Problem{ZoneCap: make([]int, zones)}
	for z := range p.ZoneCap {
		p.ZoneCap[z] = 4 + r.Intn(12)
	}
	for o := 0; o < n; o++ {
		e := r.Intn(4)
		p.Orders = append(p.Orders, Order{
			ID:     o,
			Demand: 1 + r.Intn(4),
			Zone:   r.Intn(zones),
			Window: TimeWindow{e, e + 4 + r.Intn(8)},
		})
	}
	for l := 0; l < m; l++ {
		p.Lines = append(p.Lines, Line{
			ID:        l,
			Capacity:  [2]int{3 + r.Intn(8), 3 + r.Intn(8)},
			FixedCost: r.Intn(6),
			Zone:      r.Intn(zones),
			Travel:    [2]int{r.Intn(8), r.Intn(8)},
		})
	}
	p.AssignCost = make([][][2]int, n)
	for o := 0; o < n; o++ {
		p.AssignCost[o] = make([][2]int, m)
		for l := 0; l < m; l++ {
			p.AssignCost[o][l] = [2]int{r.Intn(10), r.Intn(10)}
		}
	}
	// A few acyclic precedence pairs.
	for k := 0; k < n/2; k++ {
		i, j := r.Intn(n), r.Intn(n)
		if i < j {
			p.Precedence = append(p.Precedence, [2]int{i, j})
		}
	}
	return p
}

func checkSolveMatchesEnumerate(t *testing.T, p *Problem) {
	t.Helper()
	if err := p.Validate(); err != nil {
		t.Fatalf("invalid generated problem: %v", err)
	}
	enum := Enumerate(p)
	got := Solve(p)
	if got.Found != enum.Found {
		t.Fatalf("Found mismatch: solve=%v enum=%v", got.Found, enum.Found)
	}
	if !enum.Found {
		return
	}
	if got.Objective != enum.Objective {
		t.Fatalf("objective mismatch: solve=%d enum=%d", got.Objective, enum.Objective)
	}
	if got.Upper != enum.Objective || got.Lower != enum.Objective {
		t.Fatalf("bounds not tight: lower=%d upper=%d optimum=%d", got.Lower, got.Upper, enum.Objective)
	}
	cert := p.Certify(got.Best)
	if !cert.Feasible {
		t.Fatalf("solver returned infeasible plan: %v", cert.Violations)
	}
	if cert.Cost != got.BestCost || cert.Objective != got.Objective {
		t.Fatalf("certificate mismatch: %+v vs %+v", cert, got)
	}
	if !reflect.DeepEqual(frontierKeys(got.Frontier), frontierKeys(enum.Frontier)) {
		t.Fatalf("frontier mismatch:\nsolve=%v\nenum=%v", frontierKeys(got.Frontier), frontierKeys(enum.Frontier))
	}
}

func TestSolveMatchesEnumerateRandom(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for tc := 0; tc < 60; tc++ {
		n := 1 + r.Intn(6) // up to 6 orders
		m := 1 + r.Intn(4) // up to 4 lines
		checkSolveMatchesEnumerate(t, randomProblem(r, n, m, 1+r.Intn(3)))
	}
}

func TestSolveMatchesEnumerateFullSize(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	p := randomProblem(r, MaxOrders, MaxLines, 3)
	// Guarantee every zone has a line and loosen capacities and windows so
	// the full-size instance admits solutions.
	for l := range p.Lines {
		p.Lines[l].Zone = l % 3
	}
	for o := range p.Orders {
		p.Orders[o].Window = TimeWindow{0, 100}
	}
	p.Precedence = p.Precedence[:1]
	for z := range p.ZoneCap {
		p.ZoneCap[z] += 20
	}
	for l := range p.Lines {
		p.Lines[l].Capacity[0] += 12
		p.Lines[l].Capacity[1] += 12
	}
	checkSolveMatchesEnumerate(t, p)
	enum := Enumerate(p)
	if !enum.Found {
		t.Fatal("full-size instance unexpectedly infeasible")
	}
	if enum.Total != 1679616 { // 6^8
		t.Fatalf("Total = %d, want 1679616", enum.Total)
	}
	t.Logf("full-size: optimum=%d feasible=%d/%d frontier=%d",
		enum.Objective, enum.Feasible, enum.Total, len(enum.Frontier))
}

func TestCertificateOfOptimum(t *testing.T) {
	p := baseProblem()
	p.Lines[0].Capacity = [2]int{6, 5} // make the instance feasible
	res := Solve(p)
	if !res.Found {
		t.Fatal("no solution")
	}
	cert := p.Certify(res.Best)
	if !cert.Feasible {
		t.Fatalf("optimal plan infeasible: %v", cert.Violations)
	}
	used := 0
	for _, lc := range cert.Lines {
		if lc.Used {
			used++
			for s := 0; s < Scenarios; s++ {
				if lc.Load[s] > lc.Capacity[s] {
					t.Fatalf("line %d load exceeds capacity in scenario %d", lc.LineID, s)
				}
			}
		}
	}
	if used == 0 {
		t.Fatal("certificate shows no used line")
	}
}
