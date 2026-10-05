package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"testing"
)

// TestSolverMatchesBruteForce cross-checks the flow-based solver
// against exhaustive enumeration on many tiny random inputs.
func TestSolverMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 2000; trial++ {
		nSit := 2 + rng.Intn(5) // 2..6 sites
		nSh := 1 + rng.Intn(3)  // 1..3 shards
		nDom := 1 + rng.Intn(nSit)
		p := &Problem{Budget: rng.Intn(25)}
		for j := 0; j < nSit; j++ {
			p.Sites = append(p.Sites, Site{
				ID:       fmt.Sprintf("dc%d", j),
				Domain:   fmt.Sprintf("fd%d", rng.Intn(nDom)),
				Capacity: rng.Intn(4),
				Cost:     rng.Intn(10),
			})
		}
		for i := 0; i < nSh; i++ {
			p.Shards = append(p.Shards, Shard{ID: fmt.Sprintf("s%d", i), Replicas: 1 + rng.Intn(2)})
		}

		plan, err := Solve(p)
		if err != nil {
			t.Fatalf("trial %d: Solve error: %v", trial, err)
		}
		wantCost, feasible := bruteForceCost(p, true)
		if !feasible {
			if plan.Status != "infeasible" {
				t.Fatalf("trial %d: brute says infeasible, solver says %s (cost %d)\nproblem: %+v",
					trial, plan.Status, plan.TotalCost, p)
			}
			continue
		}
		if plan.Status != "optimal" {
			t.Fatalf("trial %d: brute feasible with cost %d, solver says %s (%s)\nproblem: %+v",
				trial, wantCost, plan.Status, plan.Reason, p)
		}
		if plan.TotalCost != wantCost {
			t.Fatalf("trial %d: solver cost %d != brute-force optimum %d\nproblem: %+v",
				trial, plan.TotalCost, wantCost, p)
		}
		if err := Verify(p, plan); err != nil {
			t.Fatalf("trial %d: solver plan failed verification: %v", trial, err)
		}
	}
}

// TestBruteForceIgnoresBudget ensures the budget flag of the oracle
// itself behaves: without budget filtering feasibility can only grow.
func TestBruteForceIgnoresBudget(t *testing.T) {
	p := &Problem{
		Budget: 0,
		Sites: []Site{
			{ID: "a", Domain: "d1", Capacity: 1, Cost: 5},
			{ID: "b", Domain: "d2", Capacity: 1, Cost: 7},
		},
		Shards: []Shard{{ID: "s0", Replicas: 2}},
	}
	if _, ok := bruteForceCost(p, true); ok {
		t.Fatal("budget 0 must make cost-12 placement infeasible")
	}
	cost, ok := bruteForceCost(p, false)
	if !ok || cost != 12 {
		t.Fatalf("without budget want cost 12, got %d (ok=%v)", cost, ok)
	}
}

// TestKnownAnswer is a small hand-computed instance.
func TestKnownAnswer(t *testing.T) {
	p := &Problem{
		Budget: 100,
		Sites: []Site{
			{ID: "cheap1", Domain: "fdA", Capacity: 1, Cost: 1},
			{ID: "cheap2", Domain: "fdA", Capacity: 1, Cost: 2}, // same domain as cheap1
			{ID: "mid", Domain: "fdB", Capacity: 2, Cost: 5},
			{ID: "pricey", Domain: "fdC", Capacity: 5, Cost: 9},
		},
		Shards: []Shard{
			{ID: "s0", Replicas: 2},
			{ID: "s1", Replicas: 2},
		},
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "optimal" {
		t.Fatalf("status %s: %s", plan.Status, plan.Reason)
	}
	// s0+s1 each need 2 distinct domains. cheap1+cheap2 share fdA, so
	// the cheapest distinct-domain pair per shard is cheap1+mid=6 and
	// cheap2+mid=7 (mid capacity 2 allows both). Total 13.
	if plan.TotalCost != 13 {
		t.Fatalf("want cost 13, got %d", plan.TotalCost)
	}
	if err := Verify(p, plan); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

// TestInfeasibleDomainCount: k=3 but only 2 failure domains exist.
func TestInfeasibleDomainCount(t *testing.T) {
	p := &Problem{
		Budget: 1000,
		Sites: []Site{
			{ID: "a", Domain: "d1", Capacity: 9, Cost: 1},
			{ID: "b", Domain: "d2", Capacity: 9, Cost: 1},
		},
		Shards: []Shard{{ID: "s0", Replicas: 3}},
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "infeasible" {
		t.Fatalf("want infeasible, got %s", plan.Status)
	}
}

// TestInfeasibleCapacity: enough domains but not enough capacity.
func TestInfeasibleCapacity(t *testing.T) {
	p := &Problem{
		Budget: 1000,
		Sites: []Site{
			{ID: "a", Domain: "d1", Capacity: 1, Cost: 1},
			{ID: "b", Domain: "d2", Capacity: 1, Cost: 1},
		},
		Shards: []Shard{
			{ID: "s0", Replicas: 2},
			{ID: "s1", Replicas: 2},
		},
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "infeasible" {
		t.Fatalf("want infeasible, got %s", plan.Status)
	}
}

// TestBudgetExceeded: feasible placement exists but costs too much.
func TestBudgetExceeded(t *testing.T) {
	p := &Problem{
		Budget: 3,
		Sites: []Site{
			{ID: "a", Domain: "d1", Capacity: 1, Cost: 2},
			{ID: "b", Domain: "d2", Capacity: 1, Cost: 2},
		},
		Shards: []Shard{{ID: "s0", Replicas: 2}},
	}
	plan, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "infeasible" || !strings.Contains(plan.Reason, "budget") {
		t.Fatalf("want budget infeasibility, got %+v", plan)
	}
}

// TestLimits enforces the 20-site / 8-shard bounds.
func TestLimits(t *testing.T) {
	p := &Problem{Budget: 1}
	for j := 0; j < MaxSites+1; j++ {
		p.Sites = append(p.Sites, Site{ID: fmt.Sprint(j), Domain: "d", Capacity: 1})
	}
	p.Shards = []Shard{{ID: "s", Replicas: 1}}
	if _, err := Solve(p); err == nil {
		t.Fatal("21 sites must be rejected")
	}
	p.Sites = p.Sites[:MaxSites]
	for i := 0; i < MaxShards+1; i++ {
		p.Shards = append(p.Shards, Shard{ID: fmt.Sprint(i), Replicas: 1})
	}
	if _, err := Solve(p); err == nil {
		t.Fatal("9 shards must be rejected")
	}
}

// TestVerifyTampering: any single-field corruption must be caught.
func TestVerifyTampering(t *testing.T) {
	p := &Problem{
		Budget: 50,
		Sites: []Site{
			{ID: "a", Domain: "d1", Capacity: 1, Cost: 3},
			{ID: "b", Domain: "d2", Capacity: 1, Cost: 4},
			{ID: "c", Domain: "d3", Capacity: 1, Cost: 5},
		},
		Shards: []Shard{{ID: "s0", Replicas: 2}},
	}
	plan, err := Solve(p)
	if err != nil || plan.Status != "optimal" {
		t.Fatalf("solve: %v %+v", err, plan)
	}
	if err := Verify(p, plan); err != nil {
		t.Fatalf("honest plan must verify: %v", err)
	}

	clone := func() *Plan {
		b, _ := json.Marshal(plan)
		var q Plan
		if err := json.Unmarshal(b, &q); err != nil {
			t.Fatal(err)
		}
		return &q
	}
	cases := map[string]func(*Plan){
		"wrong domain":   func(q *Plan) { q.Placements[0].Replicas[0].Domain = "dX" },
		"wrong cost":     func(q *Plan) { q.Placements[0].Replicas[0].Cost++ },
		"unknown site":   func(q *Plan) { q.Placements[0].Replicas[0].Site = "zzz" },
		"total cost lie": func(q *Plan) { q.TotalCost-- },
		"digest lie":     func(q *Plan) { q.Certificate.Digest = "sha256:00" },
		"capacity lie":   func(q *Plan) { q.Certificate.Sites[0].Capacity = 99 },
		"domain dup": func(q *Plan) {
			q.Placements[0].Replicas[1] = q.Placements[0].Replicas[0]
		},
		"dropped replica": func(q *Plan) {
			q.Placements[0].Replicas = q.Placements[0].Replicas[:1]
		},
	}
	for name, mutate := range cases {
		q := clone()
		mutate(q)
		if err := Verify(p, q); err == nil {
			t.Fatalf("tampered plan (%s) passed verification", name)
		}
	}
}

// TestCLI exercises solve -> verify through the command entry point.
func TestCLI(t *testing.T) {
	input := `{"budget":100,
	  "sites":[{"id":"dc1","domain":"fdA","capacity":2,"cost":5},
	           {"id":"dc2","domain":"fdB","capacity":2,"cost":7}],
	  "shards":[{"id":"s0","replicas":2}]}`
	var out bytes.Buffer
	if code := run([]string{"solve"}, strings.NewReader(input), &out, &bytes.Buffer{}); code != 0 {
		t.Fatalf("solve exit %d", code)
	}
	var plan Plan
	if err := json.Unmarshal(out.Bytes(), &plan); err != nil {
		t.Fatalf("plan JSON: %v", err)
	}
	if plan.TotalCost != 12 {
		t.Fatalf("want cost 12, got %d", plan.TotalCost)
	}

	// Round-trip through temp files for verify.
	dir := t.TempDir()
	probFile := dir + "/in.json"
	planFile := dir + "/plan.json"
	if err := os.WriteFile(probFile, []byte(input), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(planFile, out.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	var okOut bytes.Buffer
	if code := run([]string{"verify", "-i", probFile, "-p", planFile}, nil, &okOut, &bytes.Buffer{}); code != 0 {
		t.Fatalf("verify exit %d", code)
	}
	if !strings.Contains(okOut.String(), "certificate OK") {
		t.Fatalf("unexpected verify output %q", okOut.String())
	}

	// Infeasible input must exit 1.
	tight := `{"budget":1,"sites":[{"id":"dc1","domain":"fdA","capacity":2,"cost":5}],"shards":[{"id":"s0","replicas":1}]}`
	if code := run([]string{"solve"}, strings.NewReader(tight), &bytes.Buffer{}, &bytes.Buffer{}); code != 1 {
		t.Fatalf("infeasible solve exit %d, want 1", code)
	}
}
