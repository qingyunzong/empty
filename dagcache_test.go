package dagcache_test

import (
	"errors"
	"math/rand"
	"testing"

	"dagcache"
)

// randomDAG builds a random DAG with n nodes; node i may only depend on j < i.
func randomDAG(rng *rand.Rand, n int) *dagcache.Graph {
	g := &dagcache.Graph{}
	for i := 0; i < n; i++ {
		node := dagcache.Node{
			Name: string(rune('a' + i)),
			Cost: int64(rng.Intn(9) + 1),
			Size: int64(rng.Intn(3) + 1),
		}
		for j := 0; j < i; j++ {
			if rng.Intn(2) == 0 {
				node.Deps = append(node.Deps, j)
			}
		}
		g.Nodes = append(g.Nodes, node)
	}
	return g
}

// TestOptimalMatchesBruteForce cross-checks the memoized planner against the
// exhaustive, unmemoized state search on many random small graphs, and
// replays every plan with the independent simulator.
func TestOptimalMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	for trial := 0; trial < 300; trial++ {
		n := rng.Intn(6) + 2 // 2..7 nodes
		g := randomDAG(rng, n)
		m := rng.Intn(5) + 1 // 1..5 demands
		demands := make([]int, m)
		for i := range demands {
			demands[i] = rng.Intn(n)
		}
		budget := int64(rng.Intn(6)) // 0..5 space units

		plan, err := g.OptimalPlan(demands, budget)
		if err != nil {
			t.Fatalf("trial %d: OptimalPlan: %v", trial, err)
		}
		ref, err := g.BruteForceCost(demands, budget)
		if err != nil {
			t.Fatalf("trial %d: BruteForceCost: %v", trial, err)
		}
		if plan.TotalCost != ref {
			t.Fatalf("trial %d: optimal=%d brute-force=%d graph=%+v demands=%v budget=%d",
				trial, plan.TotalCost, ref, g.Nodes, demands, budget)
		}

		// Replay the plan with the independent simulator.
		caches := make([]uint64, len(plan.Steps))
		var cumulative int64
		for i, s := range plan.Steps {
			if s.CacheSize > budget {
				t.Fatalf("trial %d step %d: cache size %d exceeds budget %d",
					trial, i, s.CacheSize, budget)
			}
			cumulative += s.StepCost
			if s.Cumulative != cumulative {
				t.Fatalf("trial %d step %d: cumulative %d != %d", trial, i, s.Cumulative, cumulative)
			}
			for _, v := range s.Cache {
				caches[i] |= 1 << uint(v)
			}
		}
		sim, err := g.Simulate(demands, caches, budget)
		if err != nil {
			t.Fatalf("trial %d: Simulate: %v", trial, err)
		}
		if sim != plan.TotalCost {
			t.Fatalf("trial %d: simulator=%d plan=%d", trial, sim, plan.TotalCost)
		}
	}
}

// TestKnownExample checks a hand-computed instance.
//
//	a(2,s1) <- b(3,s1) <- c(5,s1); demands: c, c; budget 1.
//
// Optimal: compute a+b+c=10, keep c cached, second demand costs 0 -> 10.
func TestKnownExample(t *testing.T) {
	g := &dagcache.Graph{Nodes: []dagcache.Node{
		{Name: "a", Cost: 2, Size: 1},
		{Name: "b", Cost: 3, Size: 1, Deps: []int{0}},
		{Name: "c", Cost: 5, Size: 1, Deps: []int{1}},
	}}
	plan, err := g.OptimalPlan([]int{2, 2}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if plan.TotalCost != 10 {
		t.Fatalf("total cost = %d, want 10", plan.TotalCost)
	}
	if len(plan.Steps) != 2 || plan.Steps[0].StepCost != 10 || plan.Steps[1].StepCost != 0 {
		t.Fatalf("unexpected steps: %+v", plan.Steps)
	}
	if len(plan.Steps[0].Cache) != 1 || plan.Steps[0].Cache[0] != 2 {
		t.Fatalf("cache after step 0 = %v, want [2] (node c)", plan.Steps[0].Cache)
	}
}

// TestZeroBudgetForcesRecompute: nothing can be cached, every demand pays
// the full recomputation of its ancestor closure.
func TestZeroBudgetForcesRecompute(t *testing.T) {
	g := &dagcache.Graph{Nodes: []dagcache.Node{
		{Name: "a", Cost: 2, Size: 1},
		{Name: "b", Cost: 3, Size: 1, Deps: []int{0}},
	}}
	plan, err := g.OptimalPlan([]int{1, 1, 1}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.TotalCost != 15 {
		t.Fatalf("total cost = %d, want 15", plan.TotalCost)
	}
	for i, s := range plan.Steps {
		if len(s.Cache) != 0 {
			t.Fatalf("step %d: cache not empty under zero budget: %v", i, s.Cache)
		}
	}
}

func TestTooManyDemands(t *testing.T) {
	g := &dagcache.Graph{Nodes: []dagcache.Node{{Name: "a", Cost: 1, Size: 1}}}
	demands := make([]int, dagcache.MaxDemands+1)
	if _, err := g.OptimalPlan(demands, 1); !errors.Is(err, dagcache.ErrTooManyDemands) {
		t.Fatalf("OptimalPlan err = %v, want ErrTooManyDemands", err)
	}
	if _, err := g.BruteForceCost(demands, 1); !errors.Is(err, dagcache.ErrTooManyDemands) {
		t.Fatalf("BruteForceCost err = %v, want ErrTooManyDemands", err)
	}
}

func TestValidate(t *testing.T) {
	cyclic := &dagcache.Graph{Nodes: []dagcache.Node{
		{Name: "a", Cost: 1, Size: 1, Deps: []int{1}},
		{Name: "b", Cost: 1, Size: 1, Deps: []int{0}},
	}}
	if err := cyclic.Validate(); err == nil {
		t.Fatal("expected cycle error")
	}
	badDep := &dagcache.Graph{Nodes: []dagcache.Node{
		{Name: "a", Cost: 1, Size: 1, Deps: []int{7}},
	}}
	if err := badDep.Validate(); err == nil {
		t.Fatal("expected out-of-range dep error")
	}
	negative := &dagcache.Graph{Nodes: []dagcache.Node{
		{Name: "a", Cost: -1, Size: 1},
	}}
	if err := negative.Validate(); err == nil {
		t.Fatal("expected negative cost error")
	}
}

func TestSimulateRejectsInvalidDecisions(t *testing.T) {
	g := &dagcache.Graph{Nodes: []dagcache.Node{
		{Name: "a", Cost: 1, Size: 1},
		{Name: "b", Cost: 1, Size: 1},
	}}
	// Caching node 1 at step 0 is impossible: only node 0 was computed.
	if _, err := g.Simulate([]int{0}, []uint64{1 << 1}, 2); err == nil {
		t.Fatal("expected unavailable-product error")
	}
	// Budget exceeded.
	if _, err := g.Simulate([]int{0}, []uint64{1}, 0); err == nil {
		t.Fatal("expected budget error")
	}
	// Wrong number of decisions.
	if _, err := g.Simulate([]int{0}, nil, 1); err == nil {
		t.Fatal("expected length error")
	}
}
