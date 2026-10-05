package main

import (
	"math/bits"
	"math/rand"
	"testing"
)

func TestSolvePairMatchesBruteForce(t *testing.T) {
	for seed := int64(0); seed < 30; seed++ {
		r := rand.New(rand.NewSource(2000 + seed))
		n := 2 + r.Intn(10) // 2..11 nodes
		nodes := randInstance(r, n, 1+r.Intn(3), 6, 10)
		in, err := NewInstance(nodes)
		if err != nil {
			t.Fatal(err)
		}
		cons := randConstraints(r, n)
		got := SolvePair(in, cons)
		want := BruteForcePair(in, cons)
		if got.Feasible != want.Feasible {
			t.Fatalf("seed %d: feasibility mismatch: solver=%v brute=%v", seed, got.Feasible, want.Feasible)
		}
		if !got.Feasible {
			continue
		}
		if got.Cost != want.Cost {
			t.Fatalf("seed %d: union cost mismatch: solver=%d brute=%d", seed, got.Cost, want.Cost)
		}
		if got.R == got.W {
			t.Fatalf("seed %d: read and write quorums must be distinct", seed)
		}
		if !in.FTLegal(got.R, cons) || !in.FTLegal(got.W, cons) {
			t.Fatalf("seed %d: solver returned a non-fault-tolerant quorum", seed)
		}
		if inter := bits.OnesCount64(got.R & got.W); inter < 2 {
			t.Fatalf("seed %d: intersection size %d < 2", seed, inter)
		}
		if u := in.Cost(got.R | got.W); u != got.Cost {
			t.Fatalf("seed %d: reported union cost %d != actual %d", seed, got.Cost, u)
		}
		if got.LowerBound > got.Cost {
			t.Fatalf("seed %d: lower bound %d exceeds optimum %d", seed, got.LowerBound, got.Cost)
		}
	}
}

func TestSolvePairKnownAnswer(t *testing.T) {
	in, err := NewInstance([]Node{
		{ID: "a1", Domain: "a", Weight: 1, Cost: 1},
		{ID: "a2", Domain: "a", Weight: 1, Cost: 1},
		{ID: "a3", Domain: "a", Weight: 1, Cost: 1},
		{ID: "b1", Domain: "b", Weight: 1, Cost: 1},
		{ID: "b2", Domain: "b", Weight: 1, Cost: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	cons := Constraints{MinDomains: 2, MaxSize: 18}
	res := SolvePair(in, cons)
	if !res.Feasible {
		t.Fatal("expected a feasible pair")
	}
	// Fault-tolerant quorums need >= 4 nodes (2 per domain); any two
	// distinct 4-node quorums cover all 5 nodes, so the optimum union
	// cost is 5 and the lower bound is the cheapest FT quorum (4).
	if res.Cost != 5 {
		t.Fatalf("expected union cost 5, got %d", res.Cost)
	}
	if res.LowerBound != 4 {
		t.Fatalf("expected lower bound 4, got %d", res.LowerBound)
	}
	if got := in.Size(res.R | res.W); got != 5 {
		t.Fatalf("expected union of 5 nodes, got %d", got)
	}
}

// Regression: the pair scan must order candidate quorums by cost using
// keys that stay attached to their quorums.
func TestSolvePairRegressionCluster(t *testing.T) {
	in, err := NewInstance([]Node{
		{ID: "a1", Domain: "zone-a", Weight: 4, Cost: 6},
		{ID: "a2", Domain: "zone-a", Weight: 3, Cost: 4},
		{ID: "a3", Domain: "zone-a", Weight: 2, Cost: 3},
		{ID: "b1", Domain: "zone-b", Weight: 4, Cost: 7},
		{ID: "b2", Domain: "zone-b", Weight: 2, Cost: 2},
		{ID: "b3", Domain: "zone-b", Weight: 1, Cost: 2},
		{ID: "c1", Domain: "zone-c", Weight: 3, Cost: 5},
		{ID: "c2", Domain: "zone-c", Weight: 2, Cost: 3},
		{ID: "c3", Domain: "zone-c", Weight: 1, Cost: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	cons := Constraints{MinDomains: 2, MaxSize: 18}
	got := SolvePair(in, cons)
	want := BruteForcePair(in, cons)
	if !got.Feasible || !want.Feasible {
		t.Fatal("expected a feasible pair")
	}
	if got.Cost != want.Cost {
		t.Fatalf("solver=%d brute=%d", got.Cost, want.Cost)
	}
	if got.Cost != 24 {
		t.Fatalf("expected union cost 24, got %d", got.Cost)
	}
}

func TestSolvePairInfeasible(t *testing.T) {
	// Total weight 4: a fault-tolerant quorum needs a strict majority
	// even after losing a member, i.e. weight >= 3 with weight 1 lost ->
	// only the full set qualifies, so no distinct pair exists.
	in, err := NewInstance([]Node{
		{ID: "a", Domain: "x", Weight: 1, Cost: 1},
		{ID: "b", Domain: "x", Weight: 1, Cost: 1},
		{ID: "c", Domain: "y", Weight: 1, Cost: 1},
		{ID: "d", Domain: "y", Weight: 1, Cost: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	res := SolvePair(in, Constraints{MinDomains: 2, MaxSize: 18})
	if res.Feasible {
		t.Fatal("expected infeasible: only one fault-tolerant quorum exists")
	}
	bf := BruteForcePair(in, Constraints{MinDomains: 2, MaxSize: 18})
	if bf.Feasible {
		t.Fatal("brute force disagrees: expected infeasible")
	}
}

func TestFaultCertificatesHold(t *testing.T) {
	checked := 0
	for seed := int64(0); seed < 30; seed++ {
		r := rand.New(rand.NewSource(3000 + seed))
		n := 4 + r.Intn(8) // 4..11 nodes
		nodes := randInstance(r, n, 2+r.Intn(2), 6, 10)
		in, err := NewInstance(nodes)
		if err != nil {
			t.Fatal(err)
		}
		cons := Constraints{MinDomains: 2, MaxSize: 18}
		res := SolvePair(in, cons)
		if !res.Feasible {
			continue
		}
		checked++
		certs := BuildFaultCerts(in, cons, res.R, res.W)
		wantScenarios := 1 + bits.OnesCount64(res.R|res.W)
		if len(certs) != wantScenarios {
			t.Fatalf("seed %d: got %d certificates, want %d", seed, len(certs), wantScenarios)
		}
		for _, c := range certs {
			if !c.Intersect {
				t.Fatalf("seed %d: scenario %q has empty intersection", seed, c.Fault)
			}
			if !c.ReadLegal || !c.WriteLegal {
				t.Fatalf("seed %d: scenario %q leaves an illegal quorum", seed, c.Fault)
			}
			if len(c.SurvivingIntersection) == 0 {
				t.Fatalf("seed %d: scenario %q lists no surviving intersection nodes", seed, c.Fault)
			}
		}
		if certs[0].Fault != "none" {
			t.Fatalf("seed %d: first certificate should be the no-failure scenario", seed)
		}
	}
	if checked == 0 {
		t.Fatal("no feasible random instance was checked")
	}
}
