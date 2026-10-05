package route

import (
	"math/rand"
	"testing"
)

// randProblem builds a random small instance. With fuel=false no fuel
// constraint, coupons or stations are generated.
func randProblem(r *rand.Rand, full bool) *Problem {
	n := 4 + r.Intn(4) // 4..7 nodes
	p := &Problem{
		NumNodes: n,
		Start:    0,
		End:      n - 1,
		MaxNodes: 12,
	}
	// Random directed edges, density ~0.4, plus a guaranteed path
	// 0->1->...->n-1 so most instances are feasible.
	edgeSet := map[[2]int]bool{}
	addEdge := func(u, v int) {
		if u == v || edgeSet[[2]int{u, v}] {
			return
		}
		edgeSet[[2]int{u, v}] = true
		p.Edges = append(p.Edges, Edge{
			From: u, To: v,
			Toll: int64(r.Intn(25)),
			Time: int64(1 + r.Intn(15)),
			Fuel: int64(r.Intn(4)),
		})
	}
	for u := 0; u < n; u++ {
		for v := 0; v < n; v++ {
			if r.Float64() < 0.4 {
				addEdge(u, v)
			}
		}
	}
	for i := 0; i+1 < n; i++ {
		addEdge(i, i+1)
	}
	p.Rebate = Rebate{
		Threshold: int64(r.Intn(60)),
		Amount:    int64(r.Intn(30)),
	}
	if full {
		// Rebate redeemed only at designated stations (sometimes empty,
		// which means immediate redemption).
		for v := 0; v < n; v++ {
			if r.Float64() < 0.4 {
				p.Rebate.Stations = append(p.Rebate.Stations, v)
			}
		}
		if r.Float64() < 0.8 {
			p.Fuel.Capacity = int64(5 + r.Intn(8))
			p.Fuel.Start = int64(r.Intn(int(p.Fuel.Capacity) + 1))
			for v := 0; v < n; v++ {
				if r.Float64() < 0.5 {
					p.Fuel.Stations = append(p.Fuel.Stations,
						FuelStation{Node: v, Price: int64(1 + r.Intn(6))})
				}
			}
		} else {
			for i := range p.Edges {
				p.Edges[i].Fuel = 0
			}
		}
		nc := r.Intn(4) // 0..3 coupons
		for c := 0; c < nc; c++ {
			k := 1 + r.Intn(2)
			req := map[int]bool{}
			var edges []int
			for len(edges) < k {
				e := r.Intn(len(p.Edges))
				if !req[e] {
					req[e] = true
					edges = append(edges, e)
				}
			}
			p.Coupons = append(p.Coupons, Coupon{
				RequiresEdges: edges,
				Discount:      int64(1 + r.Intn(20)),
			})
		}
	} else {
		for i := range p.Edges {
			p.Edges[i].Fuel = 0
		}
	}
	if err := p.Validate(); err != nil {
		panic(err)
	}
	return p
}

// TestSearchVsEnumerationBasic cross-checks the state search against
// brute-force simple-path enumeration: tolls + one-time cumulative
// rebate only, ordered by (cost, time).
func TestSearchVsEnumerationBasic(t *testing.T) {
	for seed := int64(0); seed < 1000; seed++ {
		r := rand.New(rand.NewSource(seed))
		p := randProblem(r, false)
		res := p.Search(0)
		en := p.Enumerate()
		if res.Exhausted {
			t.Fatalf("seed %d: unlimited budget exhausted", seed)
		}
		if res.Found != en.Found {
			t.Fatalf("seed %d: found mismatch search=%v enum=%v", seed, res.Found, en.Found)
		}
		if !en.Found {
			continue
		}
		if res.Cost != en.Best.Cost || res.Time != en.Best.Time {
			t.Fatalf("seed %d: search=(%d,%d) enum=(%d,%d)",
				seed, res.Cost, res.Time, en.Best.Cost, en.Best.Time)
		}
		if res.LowerBound != res.Cost {
			t.Fatalf("seed %d: lowerBound %d != cost %d", seed, res.LowerBound, res.Cost)
		}
		if !res.Sim.OK || res.Sim.Cost != res.Cost {
			t.Fatalf("seed %d: simulation inconsistent with search cost", seed)
		}
	}
}

// TestSearchVsEnumerationFull cross-checks with coupons (mutually
// exclusive, dependent on traveled edges), rebate stations, and fuel.
func TestSearchVsEnumerationFull(t *testing.T) {
	for seed := int64(0); seed < 1000; seed++ {
		r := rand.New(rand.NewSource(seed))
		p := randProblem(r, true)
		res := p.Search(0)
		en := p.Enumerate()
		if res.Exhausted {
			t.Fatalf("seed %d: unlimited budget exhausted", seed)
		}
		if res.Found != en.Found {
			t.Fatalf("seed %d: found mismatch search=%v enum=%v", seed, res.Found, en.Found)
		}
		if !en.Found {
			continue
		}
		if res.Cost != en.Best.Cost || res.Time != en.Best.Time {
			t.Fatalf("seed %d: search=(%d,%d) enum=(%d,%d)",
				seed, res.Cost, res.Time, en.Best.Cost, en.Best.Time)
		}
		if res.LowerBound != res.Cost {
			t.Fatalf("seed %d: lowerBound %d != cost %d", seed, res.LowerBound, res.Cost)
		}
		if !res.Sim.OK || res.Sim.Cost != res.Cost {
			t.Fatalf("seed %d: simulation inconsistent with search cost", seed)
		}
	}
}

// TestBudgetKeepsFeasibleAndBound checks that when the expansion budget
// runs out, the search keeps a best feasible solution and a valid lower
// bound bracketing the optimum.
func TestBudgetKeepsFeasibleAndBound(t *testing.T) {
	sawExhausted := false
	sawFeasible := false
	for seed := int64(0); seed < 60; seed++ {
		r := rand.New(rand.NewSource(seed))
		p := randProblem(r, true)
		en := p.Enumerate()
		res := p.Search(1 + r.Intn(8)) // tiny budget
		if !res.Exhausted {
			continue
		}
		sawExhausted = true
		if res.Found {
			sawFeasible = true
			if res.LowerBound > res.Cost {
				t.Fatalf("seed %d: lowerBound %d above feasible cost %d",
					seed, res.LowerBound, res.Cost)
			}
			if !res.Sim.OK || res.Sim.Cost != res.Cost {
				t.Fatalf("seed %d: feasible solution not exactly simulated", seed)
			}
		}
		if en.Found {
			if res.LowerBound > en.Best.Cost {
				t.Fatalf("seed %d: lowerBound %d above true optimum %d",
					seed, res.LowerBound, en.Best.Cost)
			}
			if res.Found && res.Cost < en.Best.Cost {
				t.Fatalf("seed %d: feasible cost %d below true optimum %d",
					seed, res.Cost, en.Best.Cost)
			}
		}
	}
	if !sawExhausted || !sawFeasible {
		t.Fatalf("budget test did not exercise exhausted/feasible cases")
	}
}

// TestSimplePathConstraint verifies the search never repeats nodes and
// never uses more than MaxNodes nodes, even when a rebate-chasing
// detour cycle would be cheaper.
func TestSimplePathConstraint(t *testing.T) {
	p := &Problem{
		NumNodes: 4, Start: 0, End: 3, MaxNodes: 12,
		Edges: []Edge{
			{From: 0, To: 1, Toll: 6, Time: 1},  // 0
			{From: 1, To: 0, Toll: 6, Time: 1},  // 1 (cycle edge)
			{From: 1, To: 3, Toll: 6, Time: 1},  // 2
			{From: 0, To: 3, Toll: 11, Time: 9}, // 3
			{From: 0, To: 2, Toll: 1, Time: 1},  // 4
			{From: 2, To: 0, Toll: 1, Time: 1},  // 5 (cheap cycle)
		},
		Rebate: Rebate{Threshold: 10, Amount: 10},
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	res := p.Search(0)
	if !res.Found {
		t.Fatal("no route found")
	}
	// Simple paths: 0->1->3 costs 12-10=2 (time 2); 0->3 costs 11-10=1
	// (time 9). Cost first: direct edge wins with cost 1.
	if res.Cost != 1 || res.Time != 9 {
		t.Fatalf("got cost=%d time=%d, want 1/9", res.Cost, res.Time)
	}
	seen := map[int]bool{p.Start: true}
	for _, eid := range res.Path {
		v := p.Edges[eid].To
		if seen[v] {
			t.Fatalf("path repeats node %d", v)
		}
		seen[v] = true
	}
	if len(res.Path)+1 > p.MaxNodes {
		t.Fatalf("path exceeds MaxNodes")
	}
	// A cycle 0->1->0->... would "earn" the rebate repeatedly if the
	// rebate were a negative edge; cost must stay >= -R bounded and the
	// path simple.
	en := p.Enumerate()
	if en.Best.Cost != res.Cost {
		t.Fatalf("search %d != enumeration %d", res.Cost, en.Best.Cost)
	}
}

// TestMaxNodesLimit checks the node cap is enforced.
func TestMaxNodesLimit(t *testing.T) {
	p := &Problem{
		NumNodes: 5, Start: 0, End: 4, MaxNodes: 3,
		Edges: []Edge{
			{From: 0, To: 1, Toll: 1, Time: 1},
			{From: 1, To: 2, Toll: 1, Time: 1},
			{From: 2, To: 4, Toll: 1, Time: 1}, // 4 nodes: too long
			{From: 0, To: 3, Toll: 5, Time: 5},
			{From: 3, To: 4, Toll: 5, Time: 5}, // 3 nodes: ok
		},
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	res := p.Search(0)
	if !res.Found || res.Cost != 10 {
		t.Fatalf("got found=%v cost=%d, want feasible cost 10", res.Found, res.Cost)
	}
	p.MaxNodes = 2
	res = p.Search(0)
	if res.Found {
		t.Fatalf("expected infeasible with MaxNodes=2, got cost %d", res.Cost)
	}
}
