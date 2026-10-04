package cacheplan

import (
	"math/rand"
	"testing"
)

// diamond is a small DAG: app depends on libA and libB, both depend on core.
//
//	0 core  cost=10 size=4
//	1 libA  cost=6  size=3  deps: core
//	2 libB  cost=5  size=3  deps: core
//	3 app   cost=2  size=1  deps: libA, libB
func diamond() *Graph {
	return &Graph{Nodes: []Node{
		{Name: "core", Cost: 10, Size: 4},
		{Name: "libA", Cost: 6, Size: 3, Deps: []int{0}},
		{Name: "libB", Cost: 5, Size: 3, Deps: []int{0}},
		{Name: "app", Cost: 2, Size: 1, Deps: []int{1, 2}},
	}}
}

// TestHandComputed checks an exact expected optimum on the diamond DAG.
//
// demands: app, app, libA; budget 7.
// Optimal: step1 computes everything (23), caches core+libA+libB (size 10>7
// not allowed) -> cache core+libA (size 7). Step2: app needs libB -> compute
// libB+app (7); keep core+libA. Step3: libA cached -> cost 0. Total 30.
func TestHandComputed(t *testing.T) {
	g := diamond()
	p, err := Optimize(g, []int{3, 3, 1}, 7)
	if err != nil {
		t.Fatal(err)
	}
	if p.TotalCost != 30 {
		t.Fatalf("total cost = %d, want 30\n%s", p.TotalCost, p.String(g))
	}
	bf, err := BruteForce(g, []int{3, 3, 1}, 7)
	if err != nil {
		t.Fatal(err)
	}
	if bf != p.TotalCost {
		t.Fatalf("brute force = %d, plan = %d", bf, p.TotalCost)
	}
	t.Logf("\n%s", p.String(g))
}

// TestEmptyCacheCost verifies the first demand always pays its full closure.
func TestEmptyCacheCost(t *testing.T) {
	g := diamond()
	p, err := Optimize(g, []int{3}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if p.TotalCost != 23 { // 10+6+5+2
		t.Fatalf("total = %d, want 23", p.TotalCost)
	}
	if len(p.Steps[0].Cache) != 0 {
		t.Fatalf("budget 0 must leave empty cache, got %v", p.Steps[0].Cache)
	}
}

// TestCacheAvoidsRecompute: with budget enough to hold everything, the
// second identical demand costs nothing.
func TestCacheAvoidsRecompute(t *testing.T) {
	g := diamond()
	p, err := Optimize(g, []int{3, 3, 3}, 11)
	if err != nil {
		t.Fatal(err)
	}
	if p.TotalCost != 23 {
		t.Fatalf("total = %d, want 23\n%s", p.TotalCost, p.String(g))
	}
	for i, s := range p.Steps[1:] {
		if s.Cost != 0 {
			t.Fatalf("step %d cost = %d, want 0", i+2, s.Cost)
		}
	}
}

// checkInvariants validates a plan against the problem rules.
func checkInvariants(t *testing.T, g *Graph, demands []int, budget int, p *Plan) {
	t.Helper()
	clo, err := g.closures()
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Steps) != len(demands) {
		t.Fatalf("got %d steps, want %d", len(p.Steps), len(demands))
	}
	cache := map[int]bool{}
	total := 0
	for i, s := range p.Steps {
		if s.Demand != demands[i] {
			t.Fatalf("step %d demand = %d, want %d", i, s.Demand, demands[i])
		}
		// Computed set must be exactly the uncached part of the closure.
		want := map[int]bool{}
		for _, n := range maskList(clo[s.Demand]) {
			if !cache[n] {
				want[n] = true
			}
		}
		got := map[int]bool{}
		cost := 0
		for _, n := range s.Computed {
			got[n] = true
			cost += g.Nodes[n].Cost
		}
		if cost != s.Cost {
			t.Fatalf("step %d cost = %d, recomputed %d", i, s.Cost, cost)
		}
		if len(got) != len(want) {
			t.Fatalf("step %d computed %v, want %v", i, s.Computed, maskList(clo[s.Demand]))
		}
		for n := range want {
			if !got[n] {
				t.Fatalf("step %d missing computed node %d", i, n)
			}
		}
		// Cache after the step must fit budget and only contain available
		// artifacts (previously cached or just computed).
		size := 0
		next := map[int]bool{}
		for _, n := range s.Cache {
			size += g.Nodes[n].Size
			if !cache[n] && !got[n] {
				t.Fatalf("step %d caches unavailable node %d", i, n)
			}
			next[n] = true
		}
		if size > budget {
			t.Fatalf("step %d cache size %d exceeds budget %d", i, size, budget)
		}
		cache = next
		total += s.Cost
	}
	if total != p.TotalCost {
		t.Fatalf("sum of step costs = %d, plan total = %d", total, p.TotalCost)
	}
}

// randomDAG builds a random DAG with n nodes (edges only point downward).
func randomDAG(rng *rand.Rand, n int) *Graph {
	g := &Graph{Nodes: make([]Node, n)}
	for i := 0; i < n; i++ {
		g.Nodes[i] = Node{
			Name: string(rune('a' + i)),
			Cost: 1 + rng.Intn(9),
			Size: 1 + rng.Intn(5),
		}
		for j := 0; j < i; j++ {
			if rng.Intn(3) == 0 {
				g.Nodes[i].Deps = append(g.Nodes[i].Deps, j)
			}
		}
	}
	return g
}

// TestOptimizeMatchesBruteForce cross-checks the DP against exhaustive
// state search on many random small graphs, demand sequences, budgets.
func TestOptimizeMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(6)
		g := randomDAG(rng, n)
		steps := 1 + rng.Intn(6)
		demands := make([]int, steps)
		for i := range demands {
			demands[i] = rng.Intn(n)
		}
		budget := rng.Intn(12)
		p, err := Optimize(g, demands, budget)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		bf, err := BruteForce(g, demands, budget)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if p.TotalCost != bf {
			t.Fatalf("trial %d: DP=%d brute=%d demands=%v budget=%d graph=%+v",
				trial, p.TotalCost, bf, demands, budget, g.Nodes)
		}
		checkInvariants(t, g, demands, budget, p)
	}
}

// TestValidation covers rejected inputs.
func TestValidation(t *testing.T) {
	g := diamond()
	if _, err := Optimize(g, nil, 1); err == nil {
		t.Fatal("empty demands accepted")
	}
	if _, err := Optimize(g, make([]int, MaxDemands+1), 1); err == nil {
		t.Fatal("over-long demand sequence accepted")
	}
	if _, err := Optimize(g, []int{9}, 1); err == nil {
		t.Fatal("out-of-range demand accepted")
	}
	if _, err := Optimize(g, []int{0}, -1); err == nil {
		t.Fatal("negative budget accepted")
	}
	cyc := &Graph{Nodes: []Node{
		{Name: "x", Cost: 1, Size: 1, Deps: []int{1}},
		{Name: "y", Cost: 1, Size: 1, Deps: []int{0}},
	}}
	if _, err := Optimize(cyc, []int{0}, 1); err == nil {
		t.Fatal("cycle accepted")
	}
	big := &Graph{Nodes: make([]Node, maxNodes+1)}
	for i := range big.Nodes {
		big.Nodes[i] = Node{Name: "n", Cost: 1, Size: 1}
	}
	if _, err := Optimize(big, []int{0}, 1); err == nil {
		t.Fatal("oversized graph accepted")
	}
}

// TestDemandLimitBoundary: exactly MaxDemands steps must work.
func TestDemandLimitBoundary(t *testing.T) {
	g := diamond()
	demands := make([]int, MaxDemands)
	for i := range demands {
		demands[i] = i % len(g.Nodes)
	}
	p, err := Optimize(g, demands, 7)
	if err != nil {
		t.Fatal(err)
	}
	checkInvariants(t, g, demands, 7, p)
}
