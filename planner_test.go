package main

import (
	"math"
	"math/rand"
	"testing"
)

// bruteForce enumerates every placement: each shard picks exactly K sites
// with pairwise distinct fault domains; site capacities must hold. It returns
// the minimum total cost and whether any feasible placement exists. Used as
// the ground-truth oracle for tiny inputs.
func bruteForce(in *Input) (int64, bool) {
	if err := validate(in); err != nil {
		return 0, false
	}
	N := len(in.Sites)
	// Candidate site sets per shard: subsets of size K with distinct domains.
	cands := make([][][]int, len(in.Shards))
	for s := range in.Shards {
		var sets [][]int
		var rec func(start int, picked []int, doms map[string]bool)
		rec = func(start int, picked []int, doms map[string]bool) {
			if len(picked) == in.K {
				cp := append([]int(nil), picked...)
				sets = append(sets, cp)
				return
			}
			for i := start; i < N; i++ {
				d := in.Sites[i].Domain
				if doms[d] {
					continue
				}
				doms[d] = true
				rec(i+1, append(picked, i), doms)
				delete(doms, d)
			}
		}
		rec(0, nil, map[string]bool{})
		cands[s] = sets
	}
	best := int64(math.MaxInt64)
	used := make([]int, N)
	var dfs func(s int, cost int64)
	dfs = func(s int, cost int64) {
		if cost >= best {
			return
		}
		if s == len(in.Shards) {
			best = cost
			return
		}
		for _, set := range cands[s] {
			ok := true
			var c int64
			for _, i := range set {
				used[i]++
				if used[i] > in.Sites[i].Capacity {
					ok = false
				}
				c += shardCost(in, s, i)
			}
			if ok {
				dfs(s+1, cost+c)
			}
			for _, i := range set {
				used[i]--
			}
		}
	}
	dfs(0, 0)
	return best, best != int64(math.MaxInt64)
}

func randomInput(r *rand.Rand) *Input {
	nSites := 2 + r.Intn(5)   // 2..6
	nDomains := 1 + r.Intn(3) // 1..3
	nShards := 1 + r.Intn(3)  // 1..3
	in := &Input{
		K:      1 + r.Intn(2), // 1..2
		Budget: math.MaxInt64 / 4,
	}
	for i := 0; i < nSites; i++ {
		in.Sites = append(in.Sites, Site{
			ID:       string(rune('a' + i)),
			Domain:   string(rune('A' + r.Intn(nDomains))),
			Capacity: r.Intn(4),
			Cost:     int64(r.Intn(21)),
		})
	}
	for s := 0; s < nShards; s++ {
		sh := Shard{ID: string(rune('0' + s))}
		if r.Intn(2) == 0 {
			sh.Costs = map[string]int64{}
			for _, site := range in.Sites {
				if r.Intn(3) == 0 {
					sh.Costs[site.ID] = int64(r.Intn(21))
				}
			}
		}
		in.Shards = append(in.Shards, sh)
	}
	return in
}

// TestSolveMatchesBruteForce checks the min-cost-flow solver against exhaustive
// enumeration on many tiny random instances.
func TestSolveMatchesBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	feasible, infeasible := 0, 0
	for trial := 0; trial < 500; trial++ {
		in := randomInput(r)
		wantCost, wantOK := bruteForce(in)
		plan, err := Solve(in)
		if !wantOK {
			infeasible++
			if err == nil {
				t.Fatalf("trial %d: brute force says infeasible but solver returned plan %+v", trial, plan)
			}
			continue
		}
		feasible++
		if err != nil {
			t.Fatalf("trial %d: brute force found cost %d but solver errored: %v", trial, wantCost, err)
		}
		if plan.TotalCost != wantCost {
			t.Fatalf("trial %d: solver cost %d != brute force cost %d", trial, plan.TotalCost, wantCost)
		}
		if err := Verify(in, plan); err != nil {
			t.Fatalf("trial %d: solver plan failed verification: %v", trial, err)
		}
	}
	if feasible == 0 || infeasible == 0 {
		t.Fatalf("want both feasible and infeasible trials, got %d/%d", feasible, infeasible)
	}
	t.Logf("checked %d feasible and %d infeasible tiny instances", feasible, infeasible)
}

func fixedInput() *Input {
	return &Input{
		K:      2,
		Budget: 500,
		Sites: []Site{
			{ID: "s1", Domain: "d1", Capacity: 2, Cost: 10},
			{ID: "s2", Domain: "d2", Capacity: 1, Cost: 20},
			{ID: "s3", Domain: "d3", Capacity: 1, Cost: 5},
		},
		Shards: []Shard{{ID: "sh1"}, {ID: "sh2"}},
	}
}

func TestSolveFixedInstance(t *testing.T) {
	in := fixedInput()
	plan, err := Solve(in)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	// Total capacity is exactly 4 (s1:2, s2:1, s3:1), so every slot is used:
	// cost = 2*10 + 20 + 5 = 45.
	if plan.TotalCost != 45 {
		t.Fatalf("total cost = %d, want 45", plan.TotalCost)
	}
	if err := Verify(in, plan); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	cert := Certificate(in, plan)
	if len(cert) != len(in.Shards)+len(in.Sites)+1 {
		t.Fatalf("certificate has %d lines, want %d", len(cert), len(in.Shards)+len(in.Sites)+1)
	}
}

func TestBudgetEnforced(t *testing.T) {
	in := fixedInput()
	in.Budget = 45
	if _, err := Solve(in); err != nil {
		t.Fatalf("budget equal to min cost should be feasible: %v", err)
	}
	in.Budget = 44
	if _, err := Solve(in); err == nil {
		t.Fatal("budget below min cost should be infeasible")
	}
}

func TestInfeasibleNotEnoughDomains(t *testing.T) {
	in := fixedInput()
	in.K = 4 // only 3 fault domains exist
	if _, err := Solve(in); err == nil {
		t.Fatal("k=4 with 3 domains should be infeasible")
	}
}

func TestInfeasibleCapacity(t *testing.T) {
	in := fixedInput()
	in.Sites[2].Capacity = 0 // s3 (cheapest) can host nothing
	in.Sites[0].Capacity = 3 // s1 picks up the slack
	in.Sites[1].Capacity = 2 // both shards need a d2 replica
	plan, err := Solve(in)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	// Only domains d1, d2 remain: each shard takes s1+s2 = 10+20 = 30.
	if plan.TotalCost != 60 {
		t.Fatalf("total cost = %d, want 60", plan.TotalCost)
	}
}

func TestVerifyRejectsBadPlans(t *testing.T) {
	in := fixedInput()
	good, err := Solve(in)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}

	cases := map[string]func(p *Plan){
		"too few replicas": func(p *Plan) { p.Shards[0].Replicas = p.Shards[0].Replicas[:1] },
		"duplicate domain": func(p *Plan) {
			p.Shards[0].Replicas[1] = Replica{Site: "s1", Domain: in.Sites[0].Domain, Cost: 10}
		},
		"capacity exceeded": func(p *Plan) {
			p.Shards[0].Replicas[1] = Replica{Site: "s3", Domain: "d3", Cost: 5}
			p.Shards[1].Replicas[0] = Replica{Site: "s3", Domain: "d3", Cost: 5}
			p.Shards[1].Replicas[1] = Replica{Site: "s3", Domain: "d3", Cost: 5}
		},
		"wrong replica cost": func(p *Plan) { p.Shards[0].Replicas[0].Cost++ },
		"wrong total":        func(p *Plan) { p.TotalCost++ },
		"over budget":        func(p *Plan) { p.TotalCost = in.Budget + 1; p.Shards[0].Replicas[0].Cost += 2 },
		"unknown site":       func(p *Plan) { p.Shards[0].Replicas[0].Site = "nope" },
	}
	for name, mutate := range cases {
		p := *good
		p.Shards = make([]ShardPlan, len(good.Shards))
		for i, sp := range good.Shards {
			p.Shards[i] = ShardPlan{Shard: sp.Shard, Replicas: append([]Replica(nil), sp.Replicas...)}
		}
		mutate(&p)
		if err := Verify(in, &p); err == nil {
			t.Errorf("case %q: Verify accepted a bad plan", name)
		}
	}
}

func TestValidation(t *testing.T) {
	in := fixedInput()
	in.K = 0
	if _, err := Solve(in); err == nil {
		t.Fatal("k=0 should be rejected")
	}
	in = fixedInput()
	in.Sites = append(in.Sites, in.Sites[0])
	if _, err := Solve(in); err == nil {
		t.Fatal("duplicate site id should be rejected")
	}
	in = fixedInput()
	for i := 0; i < MaxShards; i++ {
		in.Shards = append(in.Shards, Shard{ID: string(rune('a' + i))})
	}
	if _, err := Solve(in); err == nil {
		t.Fatal("more than 8 shards should be rejected")
	}
}
