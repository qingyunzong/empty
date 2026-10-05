package main

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
)

func randInstance(r *rand.Rand, n, nDom, maxW, maxC int) []Node {
	nodes := make([]Node, n)
	for i := range nodes {
		nodes[i] = Node{
			ID:     fmt.Sprintf("n%d", i),
			Domain: fmt.Sprintf("d%d", r.Intn(nDom)),
			Weight: int64(r.Intn(maxW) + 1),
			Cost:   int64(r.Intn(maxC)),
		}
	}
	return nodes
}

func randConstraints(r *rand.Rand, n int) Constraints {
	return Constraints{MinDomains: 1 + r.Intn(3), MaxSize: 1 + r.Intn(n)}
}

func TestLegalBasics(t *testing.T) {
	in, err := NewInstance([]Node{
		{ID: "a", Domain: "x", Weight: 2, Cost: 1},
		{ID: "b", Domain: "y", Weight: 2, Cost: 1},
		{ID: "c", Domain: "y", Weight: 1, Cost: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	cons := Constraints{MinDomains: 2, MaxSize: 22}
	all := uint64(0b111)
	if !in.Legal(all, cons) {
		t.Fatal("full set should be legal")
	}
	if !in.Legal(0b011, cons) { // {a,b}: weight 4 of 5, domains x,y
		t.Fatal("weight-4 two-domain quorum should be legal")
	}
	if in.Legal(0b100, cons) {
		t.Fatal("single weight-1 node must not be a majority")
	}
	if in.Legal(0b110, cons) { // {b,c}: one domain only
		t.Fatal("single-domain quorum must be rejected with MinDomains=2")
	}
	cons.MaxSize = 2
	if in.Legal(all, cons) {
		t.Fatal("quorum larger than MaxSize must be rejected")
	}
}

func TestFTLegal(t *testing.T) {
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
	four := uint64(0b11011) // {a1,a2,b1,b2}
	if !in.FTLegal(four, cons) {
		t.Fatal("2+2 quorum of 4 should be fault tolerant")
	}
	three := uint64(0b01011) // {a1,a2,b1}: losing b1 leaves one domain
	if in.FTLegal(three, cons) {
		t.Fatal("quorum with a singleton domain must not be fault tolerant")
	}
	small := uint64(0b00111) // {a1,a2,a3}: legal? weight 3 of 5 majority, 1 domain -> illegal
	if in.FTLegal(small, cons) {
		t.Fatal("single-domain set must not be fault tolerant")
	}
}

func TestInstanceValidation(t *testing.T) {
	if _, err := NewInstance(nil); err == nil {
		t.Fatal("empty instance must be rejected")
	}
	if _, err := NewInstance([]Node{
		{ID: "a", Domain: "x", Weight: 1},
		{ID: "a", Domain: "x", Weight: 1},
	}); err == nil {
		t.Fatal("duplicate ids must be rejected")
	}
	if _, err := NewInstance([]Node{
		{ID: "a", Domain: "x", Weight: -1},
	}); err == nil {
		t.Fatal("negative weight must be rejected")
	}
	tooMany := make([]Node, 65)
	for i := range tooMany {
		tooMany[i] = Node{ID: fmt.Sprintf("n%d", i), Domain: "x", Weight: 1}
	}
	if _, err := NewInstance(tooMany); err == nil {
		t.Fatal("more than 64 nodes must be rejected")
	}
}

func TestSolveSingleMatchesBruteForce(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		r := rand.New(rand.NewSource(seed))
		n := 2 + r.Intn(13) // 2..14 nodes
		nodes := randInstance(r, n, 1+r.Intn(3), 8, 12)
		in, err := NewInstance(nodes)
		if err != nil {
			t.Fatal(err)
		}
		cons := randConstraints(r, n)
		got := SolveSingle(in, cons)
		want := BruteForceSingle(in, cons)
		if got.Feasible != want.Feasible {
			t.Fatalf("seed %d: feasibility mismatch: solver=%v brute=%v", seed, got.Feasible, want.Feasible)
		}
		if !got.Feasible {
			continue
		}
		if got.Cost != want.Cost {
			t.Fatalf("seed %d: cost mismatch: solver=%d brute=%d", seed, got.Cost, want.Cost)
		}
		if !in.Legal(got.Mask, cons) {
			t.Fatalf("seed %d: solver returned an illegal quorum", seed)
		}
		if c := in.Cost(got.Mask); c != got.Cost {
			t.Fatalf("seed %d: reported cost %d != actual %d", seed, got.Cost, c)
		}
	}
}

func TestSolveSingleKnownAnswer(t *testing.T) {
	in, err := NewInstance([]Node{
		{ID: "a", Domain: "x", Weight: 1, Cost: 5},
		{ID: "b", Domain: "x", Weight: 1, Cost: 5},
		{ID: "c", Domain: "y", Weight: 1, Cost: 9},
	})
	if err != nil {
		t.Fatal(err)
	}
	cons := Constraints{MinDomains: 2, MaxSize: 22}
	res := SolveSingle(in, cons)
	if !res.Feasible {
		t.Fatal("expected a feasible quorum")
	}
	// {a,b} is a majority but single-domain; cheapest legal set is {a,c} or {b,c} at 14.
	if res.Cost != 14 {
		t.Fatalf("expected cost 14, got %d", res.Cost)
	}
	if got := in.DomainCount(res.Mask); got != 2 {
		t.Fatalf("expected 2 domains, got %d", got)
	}
}

func TestSolveSingleMaxSizeInfeasible(t *testing.T) {
	nodes := make([]Node, 30)
	for i := range nodes {
		dom := "x"
		if i%2 == 0 {
			dom = "y"
		}
		nodes[i] = Node{ID: fmt.Sprintf("n%d", i), Domain: dom, Weight: 1, Cost: 1}
	}
	in, err := NewInstance(nodes)
	if err != nil {
		t.Fatal(err)
	}
	if res := SolveSingle(in, Constraints{MinDomains: 2, MaxSize: 5}); res.Feasible {
		t.Fatal("majority of 30 needs 16 nodes; MaxSize 5 must be infeasible")
	}
	res := SolveSingle(in, Constraints{MinDomains: 2, MaxSize: 22})
	if !res.Feasible {
		t.Fatal("MaxSize 22 should be feasible")
	}
	if res.Cost != 16 {
		t.Fatalf("expected cost 16, got %d", res.Cost)
	}
}

func TestEnumFTQuorumsMatchesBruteForce(t *testing.T) {
	for seed := int64(0); seed < 20; seed++ {
		r := rand.New(rand.NewSource(1000 + seed))
		n := 2 + r.Intn(10) // 2..11 nodes
		nodes := randInstance(r, n, 1+r.Intn(3), 6, 10)
		in, err := NewInstance(nodes)
		if err != nil {
			t.Fatal(err)
		}
		cons := randConstraints(r, n)
		got := enumFTQuorums(in, cons, math.MaxInt64)
		gotSet := make(map[uint64]bool, len(got))
		for _, m := range got {
			if gotSet[m] {
				t.Fatalf("seed %d: duplicate mask %b", seed, m)
			}
			gotSet[m] = true
		}
		total := uint64(1) << uint(n)
		want := 0
		for mask := uint64(0); mask < total; mask++ {
			if in.FTLegal(mask, cons) {
				want++
				if !gotSet[mask] {
					t.Fatalf("seed %d: enumeration missed mask %b", seed, mask)
				}
			}
		}
		if len(got) != want {
			t.Fatalf("seed %d: enumerated %d quorums, brute force found %d", seed, len(got), want)
		}
	}
}
