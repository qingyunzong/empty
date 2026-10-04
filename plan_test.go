package transferplan

import (
	"errors"
	"math/rand"
	"testing"
)

func mustSolve(t *testing.T, p Problem) Plan {
	t.Helper()
	plan, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if err := Verify(p, plan); err != nil {
		t.Fatalf("Verify(Solve result): %v", err)
	}
	return plan
}

func TestSolveDeterministic(t *testing.T) {
	t.Run("loss deducted before delivery", func(t *testing.T) {
		// Need 7 units at node 1; edge loses 3, so f >= 10 must be sent.
		p := Problem{
			Nodes:  2,
			Edges:  []Edge{{From: 0, To: 1, Cap: 10, Cost: 2, Loss: 3}},
			Supply: []int{10, 0},
			Demand: []int{0, 7},
		}
		plan := mustSolve(t, p)
		if plan.Cost != 20 || plan.Flows[0] != 10 {
			t.Fatalf("got %+v, want cost 20 with flow 10", plan)
		}
	})

	t.Run("unused edge costs nothing and loses nothing", func(t *testing.T) {
		p := Problem{
			Nodes:  2,
			Edges:  []Edge{{From: 0, To: 1, Cap: 10, Cost: 2, Loss: 3}},
			Supply: []int{5, 5},
			Demand: []int{5, 5},
		}
		plan := mustSolve(t, p)
		if plan.Cost != 0 || plan.Flows[0] != 0 {
			t.Fatalf("got %+v, want zero plan", plan)
		}
	})

	t.Run("lossy direct edge vs two-hop path", func(t *testing.T) {
		base := Problem{
			Nodes: 3,
			Edges: []Edge{
				{From: 0, To: 2, Cap: 20, Cost: 1, Loss: 5}, // direct, lossy
				{From: 0, To: 1, Cap: 20, Cost: 1, Loss: 0},
				{From: 1, To: 2, Cap: 20, Cost: 1, Loss: 0},
			},
			Supply: []int{20, 0, 0},
			Demand: []int{0, 0, 6},
		}
		// Direct: f=11, cost 11; two-hop: 6+6=12. Direct wins.
		plan := mustSolve(t, base)
		if plan.Cost != 11 {
			t.Fatalf("direct: got cost %d, want 11 (%+v)", plan.Cost, plan)
		}
		// Raise direct cost to 2: direct 22, two-hop 12. Path wins.
		base.Edges[0].Cost = 2
		plan = mustSolve(t, base)
		if plan.Cost != 12 || plan.Flows[0] != 0 {
			t.Fatalf("two-hop: got %+v, want cost 12 via edges 1,2", plan)
		}
	})

	t.Run("fixed loss is not per unit", func(t *testing.T) {
		// One shipment of 10 loses 3 once: delivers 7 for cost 10.
		p := Problem{
			Nodes:  2,
			Edges:  []Edge{{From: 0, To: 1, Cap: 10, Cost: 1, Loss: 3}},
			Supply: []int{10, 0},
			Demand: []int{0, 7},
		}
		plan := mustSolve(t, p)
		if plan.Cost != 10 {
			t.Fatalf("got cost %d, want 10", plan.Cost)
		}
	})

	t.Run("infeasible when demand exceeds deliverable supply", func(t *testing.T) {
		p := Problem{
			Nodes:  2,
			Edges:  []Edge{{From: 0, To: 1, Cap: 10, Cost: 1, Loss: 3}},
			Supply: []int{10, 0},
			Demand: []int{0, 8}, // max delivery is 10-3=7
		}
		if _, err := Solve(p); !errors.Is(err, ErrInfeasible) {
			t.Fatalf("got %v, want ErrInfeasible", err)
		}
	})

	t.Run("loss above capacity disables edge", func(t *testing.T) {
		p := Problem{
			Nodes:  2,
			Edges:  []Edge{{From: 0, To: 1, Cap: 5, Cost: 1, Loss: 6}},
			Supply: []int{10, 0},
			Demand: []int{0, 1},
		}
		if _, err := Solve(p); !errors.Is(err, ErrInfeasible) {
			t.Fatalf("got %v, want ErrInfeasible", err)
		}
	})

	t.Run("no edges", func(t *testing.T) {
		ok := Problem{Nodes: 2, Supply: []int{3, 4}, Demand: []int{3, 2}}
		plan := mustSolve(t, ok)
		if plan.Cost != 0 {
			t.Fatalf("got cost %d, want 0", plan.Cost)
		}
		bad := Problem{Nodes: 2, Supply: []int{3, 4}, Demand: []int{4, 4}}
		if _, err := Solve(bad); !errors.Is(err, ErrInfeasible) {
			t.Fatalf("got %v, want ErrInfeasible", err)
		}
	})
}

func TestValidate(t *testing.T) {
	good := Problem{Nodes: 1, Supply: []int{0}, Demand: []int{0}}
	cases := []Problem{
		{Nodes: 0},
		{Nodes: MaxNodes + 1, Supply: make([]int, MaxNodes+1), Demand: make([]int, MaxNodes+1)},
		{Nodes: 1, Edges: make([]Edge, MaxEdges+1), Supply: []int{0}, Demand: []int{0}},
		{Nodes: 1, Supply: []int{MaxStock + 1}, Demand: []int{0}},
		{Nodes: 1, Supply: []int{0}, Demand: []int{MaxStock + 1}},
		{Nodes: 1, Supply: []int{0}, Demand: []int{0}, Edges: []Edge{{From: 0, To: 1}}},
		{Nodes: 1, Supply: []int{0}, Demand: []int{0}, Edges: []Edge{{From: 0, To: 0}}},
		{Nodes: 2, Supply: []int{0, 0}, Demand: []int{0, 0}, Edges: []Edge{{From: 0, To: 1, Cap: -1}}},
	}
	if err := good.Validate(); err != nil {
		t.Fatalf("good problem rejected: %v", err)
	}
	for i, p := range cases {
		if err := p.Validate(); err == nil {
			t.Errorf("case %d: want validation error, got nil", i)
		}
	}
}

// randomProblem builds a random instance small enough for Enumerate.
func randomProblem(rng *rand.Rand) Problem {
	nodes := 2 + rng.Intn(5) // 2..6
	p := Problem{
		Nodes:  nodes,
		Supply: make([]int, nodes),
		Demand: make([]int, nodes),
	}
	combos := 1
	edges := 1 + rng.Intn(7) // 1..7
	for len(p.Edges) < edges {
		e := Edge{
			From: rng.Intn(nodes),
			To:   rng.Intn(nodes),
			Cap:  rng.Intn(6),
			Cost: rng.Intn(6),
			Loss: rng.Intn(4),
		}
		if e.From == e.To {
			continue
		}
		if combos *= e.Cap + 1; combos > 300000 {
			break // keep enumeration tractable
		}
		p.Edges = append(p.Edges, e)
	}
	for i := 0; i < nodes; i++ {
		p.Supply[i] = rng.Intn(9)
		p.Demand[i] = rng.Intn(6)
	}
	return p
}

func TestSolveMatchesEnumeration(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	feasible := 0
	for trial := 0; trial < 1000; trial++ {
		p := randomProblem(rng)
		got, errSolve := Solve(p)
		want, errEnum := Enumerate(p)
		if (errSolve == nil) != (errEnum == nil) {
			t.Fatalf("trial %d: feasibility mismatch: Solve=%v Enumerate=%v\n%+v",
				trial, errSolve, errEnum, p)
		}
		if errSolve != nil {
			if !errors.Is(errSolve, ErrInfeasible) {
				t.Fatalf("trial %d: unexpected error %v", trial, errSolve)
			}
			continue
		}
		feasible++
		if got.Cost != want.Cost {
			t.Fatalf("trial %d: Solve cost %d, Enumerate cost %d\n%+v",
				trial, got.Cost, want.Cost, p)
		}
		if err := Verify(p, got); err != nil {
			t.Fatalf("trial %d: Solve plan invalid: %v\n%+v", trial, err, p)
		}
	}
	t.Logf("cross-checked 1000 random instances, %d feasible", feasible)
}

// TestSolveAtSizeLimits exercises the maximum allowed dimensions
// (8 nodes, 10 edges, inventory 20), where full enumeration would be
// infeasible (21^10 assignments).
func TestSolveAtSizeLimits(t *testing.T) {
	p := Problem{
		Nodes:  8,
		Supply: []int{20, 0, 0, 0, 0, 0, 0, 0},
		Demand: []int{0, 0, 0, 0, 0, 0, 0, 12},
	}
	for i := 0; i < 7; i++ { // chain 0->1->...->7
		p.Edges = append(p.Edges, Edge{From: i, To: i + 1, Cap: 20, Cost: 1, Loss: 1})
	}
	// Shortcut edges with higher cost but no loss.
	p.Edges = append(p.Edges,
		Edge{From: 0, To: 3, Cap: 20, Cost: 4, Loss: 0},
		Edge{From: 3, To: 6, Cap: 20, Cost: 4, Loss: 0},
		Edge{From: 6, To: 7, Cap: 20, Cost: 4, Loss: 0},
	)
	plan := mustSolve(t, p)
	// Pure chain: send 19 at node 0, cost 19+18+...+13 = 112.
	// Optimum 110: chain 0->3 (send 16, cost 45), shortcut 3->6
	// (send 13, cost 52), chain 6->7 (send 13, cost 13).
	if plan.Cost != 110 {
		t.Fatalf("got cost %d, want 110 (flows %v)", plan.Cost, plan.Flows)
	}
	t.Logf("max-size instance solved at cost %d, flows %v", plan.Cost, plan.Flows)
}
