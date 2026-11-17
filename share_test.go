package formal

import (
	"math"
	"math/rand"
	"testing"
)

// Idle guarantee flows to siblings within a subtree before crossing
// branches: B absorbs A's idle share under P1 and then P2's spare capacity.
func TestFairSharesBorrowing(t *testing.T) {
	tree := &Tree{Root: intern("root", 10,
		intern("p1", 5, leaf("a", 3), leaf("b", 2)),
		intern("p2", 5, leaf("c", 5)),
	)}
	shares, err := FairShares(tree, 10, map[string]float64{"p1/a": 0, "p1/b": 10, "p2/c": 3})
	if err != nil {
		t.Fatalf("FairShares: %v", err)
	}
	want := map[string]float64{"p1/a": 0, "p1/b": 7, "p2/c": 3}
	for q, w := range want {
		if math.Abs(shares[q]-w) > 1e-9 {
			t.Fatalf("share[%s] = %v, want %v (all: %v)", q, shares[q], w, shares)
		}
	}
}

// For random valid trees and demands, every queue receives at least
// min(demand, guarantee) and the shares never exceed capacity or demand.
func TestFairSharesGuaranteeHonored(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		r := rand.New(rand.NewSource(3000 + seed))
		tree, queues, capacity := randomTree(r)
		demand := map[string]float64{}
		for _, q := range queues {
			demand[q] = float64(r.Intn(12))
		}
		shares, err := FairShares(tree, float64(capacity), demand)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		leaves := tree.leaves()
		var total float64
		for q, d := range demand {
			g := float64(leaves[q].node.Guarantee)
			want := math.Min(d, g)
			if shares[q]+1e-9 < want {
				t.Fatalf("seed %d: queue %s share %v < min(demand %v, guarantee %v)", seed, q, shares[q], d, g)
			}
			if shares[q] > d+1e-9 {
				t.Fatalf("seed %d: queue %s share %v exceeds demand %v", seed, q, shares[q], d)
			}
			total += shares[q]
		}
		if total > float64(capacity)+1e-9 {
			t.Fatalf("seed %d: shares sum %v exceeds capacity %v", seed, total, capacity)
		}
	}
}
